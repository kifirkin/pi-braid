// Test the fixed REPL tool
async function main() {
  const mod = await import("./repl/index.js");
  const repl = mod.default;

  const pi: any = {
    registerTool: async (tool: any) => {
      console.log("Tool:", tool.name, "| label:", tool.label);
      console.log("promptSnippet:", tool.promptSnippet);
      console.log("---");

      const call = async (n: number, params: any): Promise<any> => {
        try {
          const r = await tool.execute(`tc_${n}`, params);
          const text = r.content[0].text;
          console.log(`#${n} code: ${JSON.stringify(params.code)}`);
          console.log(`    result: ${text.split("=> ").slice(1).join("=> ")}`);
          if (r.details?.result !== undefined) {
            console.log(
              `    details.result: ${JSON.stringify(r.details.result)}`,
            );
          }
          return r;
        } catch (e: any) {
          console.log(`#${n} code: ${JSON.stringify(params.code)}`);
          console.log(`    THREW: ${e.message}`);
          return null;
        }
      };

      await call(1, { code: "const a = 1; const b = 2; a + b" });
      await call(2, { code: "1 + 2" });
      await call(3, { code: "Math.sqrt(16)" });
      await call(4, { code: "return 42" });
      await call(5, { code: "const x = 5" }); // declaration, should be undefined
      await call(6, { code: "if (true) { 99 }" }); // control flow, should be undefined
      await call(7, { code: "({ a: 1, b: [2, 3] })" }); // object literal
      await call(8, { code: "const r = { x: 1 }; r.x * 2" });
      await call(9, { code: "const xs = [1,2,3]; xs.map(n => n*2)" });
      await call(10, { code: "foo()" }); // ReferenceError
      await call(11, { code: "x + 1;" }); // trailing semi
      await call(12, { code: "a;b;c" }); // only last returned
      await call(13, { code: "" }); // empty
      await call(14, { code: "  " }); // whitespace

      console.log("\n--- persistence ---");
      await call(15, { code: "lastResult + 1" });
      await call(16, { code: "lastResult * 2" });

      console.log(
        "\n--- timeout test (async infinite loop yields to event loop) ---",
      );
      const start = Date.now();
      await call(17, {
        code: "while(true){ await new Promise(r => setImmediate(r)) }",
        timeout_ms: 100,
      });
      const elapsed = Date.now() - start;
      console.log(`    (elapsed: ${elapsed}ms — should be ~100)`);

      console.log("\n--- reset test ---");
      await call(18, {
        code: "const y = lastResult; reset(); lastResult",
        reset: true,
      });

      console.log("\nAll tests done.");
    },
  };
  repl(pi);
}
main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
