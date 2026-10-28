import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/** Печатает правила iptables/ip6tables для сети cg-sessions (deploy/README.md). */
const script = join(import.meta.dir, "../session-isolation.sh");

const print = (args: string[]) => Bun.spawnSync(["bash", script, "print", ...args]);

const BASE_ARGS = ["--subnet", "172.29.0.0/16", "--bridge", "br-test", "--api-ip", "172.29.0.5"];

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

  it("allows only cg-api to reach session port 8080 across the bridge", () => {
    const out = print(BASE_ARGS).stdout.toString("utf8");
    const allow = "-A DOCKER-USER -i br-test -o br-test -s 172.29.0.5 -p tcp --dport 8080 -j RETURN";
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
    const accept = "-A CG-SESSIONS-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT";
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
    const withV6 = print([...BASE_ARGS, "--subnet6", "fd00:cafe::/64"]).stdout.toString("utf8");
    expect(withV6).toContain(
      "#   ip6tables -C INPUT -i br-test -j CG-SESSIONS-IN 2>/dev/null || ip6tables -I INPUT 1 -i br-test -j CG-SESSIONS-IN",
    );
    // Разделитель частей — одна строка.
    expect(withV6.split("\n").filter((l) => l === "# ip6tables")).toHaveLength(1);
  });

  it("lets DNS to a host resolver in a private range through before the private-range DROPs", () => {
    const out = print([...BASE_ARGS, "--resolver", "192.168.1.1"]).stdout.toString("utf8");
    const privateDrop = lineIndex(out, "-A DOCKER-USER -i br-test -d 192.168.0.0/16 -j DROP");
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
    expect(print(BASE_ARGS).stdout.toString("utf8")).not.toContain("--dport 53");
  });

  it("rejects a resolver that is not an IPv4 literal with exit 2", () => {
    for (const resolver of ["192.168.1", "fd00::53", "dns.example", "192.168.1.256"]) {
      const r = print([...BASE_ARGS, "--resolver", resolver]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString("utf8")).toBe("");
    }
  });

  it("rules cover ipv6 when the network has an ipv6 subnet", () => {
    const withV6 = print([...BASE_ARGS, "--subnet6", "fd00:cafe::/64"]).stdout.toString("utf8");
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
    const r = print(["--subnet", "1.2.3", "--bridge", "br-test", "--api-ip", "172.29.0.5"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString("utf8")).toBe("");
  });

  it("rejects a flag without a value with exit 2", () => {
    const r = print(["--subnet"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString("utf8")).toBe("");
  });
});
