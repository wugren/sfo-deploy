const command = new Deno.Command("deno", {
  args: ["check", "--frozen", "tests/contract/app_schema1_removed_consumer.ts"],
  stdin: "null",
});
const output = await command.output();
const stderr = new TextDecoder().decode(output.stderr);

if (output.success) {
  throw new Error("已移除的 App management.actions 类型路径意外通过编译");
}
if (!stderr.includes("Property 'actions' does not exist")) {
  throw new Error(`旧 App 类型路径未按预期失败:\n${stderr}`);
}
