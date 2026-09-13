const command = new Deno.Command("deno", {
  args: ["check", "--frozen", "tests/contract/app_schema1_removed_types_consumer.ts"],
  stdin: "null",
});
const output = await command.output();
const stderr = new TextDecoder().decode(output.stderr);

if (output.success) {
  throw new Error("removed App schema 1 scripts/management.service types unexpectedly compiled");
}
const required = [
  "Property 'scripts' does not exist",
  "Property 'service' does not exist",
];
for (const message of required) {
  if (!stderr.includes(message)) {
    throw new Error(`old App type path did not fail as expected; missing ${message}:\n${stderr}`);
  }
}
