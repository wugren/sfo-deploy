// 检查 Nginx 可执行文件是否存在。

const result = await new Deno.Command("/usr/bin/test", {
  args: ["-x", "/usr/sbin/nginx"],
  stdin: "null",
  stdout: "null",
  stderr: "null",
}).output();
Deno.exit(result.success ? 0 : 1);
