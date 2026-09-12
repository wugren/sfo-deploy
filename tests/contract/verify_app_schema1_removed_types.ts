const command = new Deno.Command("deno", {
  args: ["check", "--frozen", "tests/contract/app_schema1_removed_types_consumer.ts"],
  stdin: "null",
});
const output = await command.output();
const stderr = new TextDecoder().decode(output.stderr);

if (output.success) {
  throw new Error("App schema 1 已移除的 scripts/management.service 类型意外通过编译");
}
const required = [
  "Property 'scripts' does not exist",
  "Property 'service' does not exist",
];
for (const message of required) {
  if (!stderr.includes(message)) {
    throw new Error(`旧 App 类型路径未按预期失败，缺少 ${message}:\n${stderr}`);
  }
}
