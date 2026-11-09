import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Печатает правила iptables/ip6tables для сети cg-sessions (deploy/README.md). */
const script = join(import.meta.dir, "../session-isolation.sh");

const print = (args: string[]) =>
  Bun.spawnSync(["bash", script, "print", ...args]);

const BASE_ARGS = [
  "--subnet",
  "172.29.0.0/16",
  "--bridge",
  "br-test",
  "--agent-ip",
  "172.29.0.5",
];

/** Индекс первого совпадения строки `needle` среди строк вывода; -1, если не нашлось. */
const lineIndex = (stdout: string, needle: string) =>
  stdout.split("\n").findIndex((l) => l === needle);

describe("session-isolation.sh print", () => {
  it("prints DOCKER-USER rules for the session subnet", () => {
    const r = print(BASE_ARGS);
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString("utf8");
    expect(out).toContain(
      "-A DOCKER-USER -i br-test -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
    );
    for (const net of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "100.64.0.0/10",
    ]) {
      expect(out).toContain(`-A DOCKER-USER -i br-test -d ${net} -j DROP`);
    }
    expect(out).toContain("COMMIT");
  });

  it("allows the agent container to reach 8080", () => {
    const out = print(BASE_ARGS).stdout.toString("utf8");
    const allow =
      "-A DOCKER-USER -i br-test -o br-test -s 172.29.0.5 -p tcp --dport 8080 -j RETURN";
    const drop = "-A DOCKER-USER -i br-test -o br-test -j DROP";
    const allowAt = lineIndex(out, allow);
    const dropAt = lineIndex(out, drop);
    expect(allowAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(allowAt).toBeLessThan(dropAt);
  });

  it("blocks session access to host addresses in a dedicated chain", () => {
    const out = print(BASE_ARGS).stdout.toString("utf8");
    const lines = out.split("\n");
    expect(lines).toContain(":CG-SESSIONS-IN - [0:0]");
    const accept =
      "-A CG-SESSIONS-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT";
    const drop = "-A CG-SESSIONS-IN -j DROP";
    const acceptAt = lineIndex(out, accept);
    const dropAt = lineIndex(out, drop);
    expect(acceptAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(acceptAt).toBeLessThan(dropAt);
    // INPUT хоста в дампе не объявляется и не дополняется: правила `-A` встали бы после
    // разрешений хоста, `-I` задваивался бы при повторном применении.
    expect(lines.filter((l) => /^(:INPUT|-[AI] INPUT)/.test(l))).toEqual([]);
  });

  it("prints the INPUT jump as a first-rule insert guarded by -C", () => {
    const out = print(BASE_ARGS).stdout.toString("utf8");
    expect(out).toContain(
      "#   iptables -C INPUT -i br-test -j CG-SESSIONS-IN 2>/dev/null || iptables -I INPUT 1 -i br-test -j CG-SESSIONS-IN",
    );
    const withV6 = print([
      ...BASE_ARGS,
      "--subnet6",
      "fd00:cafe::/64",
    ]).stdout.toString("utf8");
    expect(withV6).toContain(
      "#   ip6tables -C INPUT -i br-test -j CG-SESSIONS-IN 2>/dev/null || ip6tables -I INPUT 1 -i br-test -j CG-SESSIONS-IN",
    );
    // Разделитель частей — одна строка.
    expect(withV6.split("\n").filter((l) => l === "# ip6tables")).toHaveLength(
      1,
    );
  });

  it("lets DNS to a host resolver in a private range through before the private-range DROPs", () => {
    const out = print([
      ...BASE_ARGS,
      "--resolver",
      "192.168.1.1",
    ]).stdout.toString("utf8");
    const privateDrop = lineIndex(
      out,
      "-A DOCKER-USER -i br-test -d 192.168.0.0/16 -j DROP",
    );
    const inputDrop = lineIndex(out, "-A CG-SESSIONS-IN -j DROP");
    for (const proto of ["udp", "tcp"]) {
      const forward = lineIndex(
        out,
        `-A DOCKER-USER -i br-test -d 192.168.1.1 -p ${proto} --dport 53 -j RETURN`,
      );
      expect(forward).toBeGreaterThanOrEqual(0);
      expect(forward).toBeLessThan(privateDrop);
      const input = lineIndex(
        out,
        `-A CG-SESSIONS-IN -d 192.168.1.1 -p ${proto} --dport 53 -j ACCEPT`,
      );
      expect(input).toBeGreaterThanOrEqual(0);
      expect(input).toBeLessThan(inputDrop);
    }
    // Без --resolver исключений для :53 нет.
    expect(print(BASE_ARGS).stdout.toString("utf8")).not.toContain(
      "--dport 53",
    );
  });

  it("rejects a resolver that is not an IPv4 literal with exit 2", () => {
    for (const resolver of [
      "192.168.1",
      "fd00::53",
      "dns.example",
      "192.168.1.256",
    ]) {
      const r = print([...BASE_ARGS, "--resolver", resolver]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString("utf8")).toBe("");
    }
  });

  it("rules cover ipv6 when the network has an ipv6 subnet", () => {
    const withV6 = print([
      ...BASE_ARGS,
      "--subnet6",
      "fd00:cafe::/64",
    ]).stdout.toString("utf8");
    const v6At = lineIndex(withV6, "# ip6tables");
    expect(v6At).toBeGreaterThanOrEqual(0);
    expect(withV6).toContain("-d fc00::/7 -j DROP");
    expect(withV6).toContain("-d fe80::/10 -j DROP");

    const withoutV6 = print(BASE_ARGS).stdout.toString("utf8");
    expect(withoutV6).not.toContain("# ip6tables");
    expect(withoutV6).not.toContain("fc00::/7");
    expect(withoutV6).not.toContain("fe80::/10");
  });

  it("rejects a malformed subnet with exit 2", () => {
    const r = print([
      "--subnet",
      "1.2.3",
      "--bridge",
      "br-test",
      "--agent-ip",
      "172.29.0.5",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString("utf8")).toBe("");
  });

  it("rejects a flag without a value with exit 2", () => {
    const r = print(["--subnet"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString("utf8")).toBe("");
  });
});

/** Заглушка команды `name` в `dir`: bash-скрипт `body`. */
const stub = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

describe("session-isolation.sh apply-local", () => {
  /**
   * Заглушки в PATH: сеть cg-sessions с мостом `br-cg` и подсетью 172.31.240.0/24 (адрес
   * cg-agent у неё закреплён, docker inspect cg-agent не нужен); iptables-restore, iptables,
   * netfilter-persistent, apt-get и debconf-set-selections пишут, что получили, в `log`.
   * `persistent` — есть ли уже netfilter-persistent; `aptFails` — apt-get падает.
   */
  const withStubs = (
    opts: { uid?: string; persistent?: boolean; aptFails?: boolean },
    test: (dir: string, log: string) => void,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-isolation-"));
    const log = join(dir, "log");
    writeFileSync(log, "");
    try {
      stub(dir, "id", `[ "$1" = -u ] && echo ${opts.uid ?? "0"}`);
      stub(
        dir,
        "docker",
        `case "$1 $2" in
"network inspect") echo 'net0123456789abcdef|{"com.docker.network.bridge.name":"br-cg"}|172.31.240.0/24;' ;;
*) echo "unexpected docker $*" >&2; exit 1 ;;
esac`,
      );
      stub(
        dir,
        "iptables-restore",
        `{ echo "== iptables-restore $*"; cat; } >> "${log}"`,
      );
      stub(
        dir,
        "ip6tables-restore",
        `{ echo "== ip6tables-restore $*"; cat; } >> "${log}"`,
      );
      stub(dir, "iptables", `echo "iptables $*" >> "${log}"; [ "$1" != -C ]`);
      const persistent = `echo "netfilter-persistent $*" >> "${log}"`;
      if (opts.persistent ?? true)
        stub(dir, "netfilter-persistent", persistent);
      stub(
        dir,
        "debconf-set-selections",
        `{ echo "== debconf-set-selections"; cat; } >> "${log}"`,
      );
      // Установка пакета «кладёт» netfilter-persistent в PATH.
      stub(
        dir,
        "apt-get",
        `echo "apt-get $* DEBIAN_FRONTEND=$DEBIAN_FRONTEND" >> "${log}"
${opts.aptFails ? "exit 100" : ""}
if [ "$1" = install ]; then printf '#!/usr/bin/env bash\\n%s\\n' '${persistent}' > "${dir}/netfilter-persistent"; chmod +x "${dir}/netfilter-persistent"; fi`,
      );
      test(dir, log);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const applyLocal = (dir: string, args: string[] = [], env = {}) =>
    Bun.spawnSync(["bash", script, "apply-local", ...args], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    });

  it("applies rules with the pinned cg-agent IP, the INPUT jump and saves them", () =>
    withStubs({}, (dir, log) => {
      const r = applyLocal(dir, ["--agent-ip", "172.31.240.2"]);
      expect(r.stderr.toString("utf8")).not.toContain("ОШИБКА");
      expect(r.exitCode).toBe(0);
      const out = readFileSync(log, "utf8");
      const lines = out.split("\n");
      expect(lines).toContain("== iptables-restore -n");
      expect(lines).toContain(
        "-A DOCKER-USER -i br-cg -o br-cg -s 172.31.240.2 -p tcp --dport 8080 -j RETURN",
      );
      // Без IPv6-подсети ip6tables не трогается; переход из INPUT — после проверки -C.
      expect(out).not.toContain("ip6tables-restore");
      const check = lines.indexOf(
        "iptables -C INPUT -i br-cg -j CG-SESSIONS-IN",
      );
      const insert = lines.indexOf(
        "iptables -I INPUT 1 -i br-cg -j CG-SESSIONS-IN",
      );
      expect(check).toBeGreaterThanOrEqual(0);
      expect(insert).toBeGreaterThan(check);
      expect(lines.at(-2)).toBe("netfilter-persistent save");
      expect(out).not.toContain("apt-get");
    }));

  it("takes the agent IP from CG_AGENT_IP and refuses one outside the network subnet", () =>
    withStubs({}, (dir, log) => {
      const r = applyLocal(dir, [], { CG_AGENT_IP: "172.31.240.9" });
      expect(r.exitCode).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(
        "-s 172.31.240.9 -p tcp --dport 8080",
      );

      writeFileSync(log, "");
      const outside = applyLocal(dir, ["--agent-ip", "172.29.0.2"]);
      expect(outside.exitCode).toBe(1);
      expect(outside.stderr.toString("utf8")).toContain("172.31.240.0/24");
      expect(readFileSync(log, "utf8")).toBe("");
    }));

  it("installs iptables-persistent without questions when it is missing", () =>
    withStubs({ persistent: false }, (dir, log) => {
      const r = applyLocal(dir, ["--agent-ip", "172.31.240.2"]);
      expect(r.stderr.toString("utf8")).not.toContain("ОШИБКА");
      expect(r.exitCode).toBe(0);
      const lines = readFileSync(log, "utf8").split("\n");
      const debconf = lines.indexOf("== debconf-set-selections");
      expect(lines[debconf + 1]).toBe(
        "iptables-persistent iptables-persistent/autosave_v4 boolean false",
      );
      expect(lines[debconf + 2]).toBe(
        "iptables-persistent iptables-persistent/autosave_v6 boolean false",
      );
      const install = lines.findIndex((l) =>
        l.startsWith("apt-get install -y -qq --no-remove iptables-persistent"),
      );
      expect(install).toBeGreaterThan(debconf);
      expect(lines[install]).toContain("DEBIAN_FRONTEND=noninteractive");
      expect(lines.indexOf("netfilter-persistent save")).toBeGreaterThan(
        install,
      );
    }));

  it("fails when the rules cannot be persisted", () =>
    withStubs({ persistent: false, aptFails: true }, (dir) => {
      const r = applyLocal(dir, ["--agent-ip", "172.31.240.2"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString("utf8")).toContain("iptables-persistent");
    }));

  it("refuses to apply without root", () =>
    withStubs({ uid: "1000" }, (dir, log) => {
      const r = applyLocal(dir);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString("utf8")).toContain("root");
      expect(readFileSync(log, "utf8")).toBe("");
    }));
});
