// 安装 Ubuntu/Debian 发行版的 Nginx 包；不固定具体包版本。

async function aptGet(args: string[]): Promise<void> {
  const result = await new Deno.Command("/usr/bin/apt-get", {
    args,
    clearEnv: true,
    env: {
      DEBIAN_FRONTEND: "noninteractive",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(`apt-get failed with exit code ${result.code}`);
  }
}

await aptGet(["update"]);
await aptGet(["install", "-y", "--no-install-recommends", "nginx"]);
