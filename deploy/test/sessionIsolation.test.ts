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

  it("blocks session access to host addresses", () => {
    const out = print(BASE_ARGS).stdout.toString("utf8");
    const accept = "-A INPUT -i br-test -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT";
    const drop = "-A INPUT -i br-test -j DROP";
    const acceptAt = lineIndex(out, accept);
    const dropAt = lineIndex(out, drop);
    expect(acceptAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(acceptAt).toBeLessThan(dropAt);
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
});
