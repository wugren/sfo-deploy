const command = new Deno.Command("deno", {
  args: ["check", "--frozen", "tests/contract/app_schema1_removed_consumer.ts"],
  stdin: "null",
});
const output = await command.output();
const stderr = new TextDecoder().decode(output.stderr);

if (output.success) {
  throw new Error("removed App management.actions type path unexpectedly compiled");
}
if (!stderr.includes("Property 'actions' does not exist")) {
  throw new Error(`old App type path did not fail as expected:\n${stderr}`);
}
