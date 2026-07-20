// Ported from an ad-hoc scratch suite into the repo so it survives the session
// that wrote it. Runs against the COMPILED output in dist-electron, offline:
// no provider is called and no API key is read.

// The capability check runs before an unattended loop starts. Getting it wrong
// in the strict direction is worse than useless: it would refuse the local-first
// setup the feature exists to serve.
import { fromBuild } from "../harness.mjs";
const m = await fromBuild("electron/loops.js");
const { ollamaParamBillions, assessLoopCapability, LOOP_CAPABLE_LOCAL_PARAMS_B } = m;

let pass = 0, total = 0;
const check = (label, got, want) => {
  total += 1;
  const ok = got === want;
  if (ok) pass += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("PARSING REAL OLLAMA TAGS (these are the ones on Lachy's machine)");
check("qwen3:8b", ollamaParamBillions("qwen3:8b"), 8);
check("qwen:4b", ollamaParamBillions("qwen:4b"), 4);
check("qwen3:1.7b", ollamaParamBillions("qwen3:1.7b"), 1.7);
check("deepseek-r1:7b", ollamaParamBillions("deepseek-r1:7b"), 7);
check("gemma4:e4b (letter prefix)", ollamaParamBillions("gemma4:e4b"), 4);
check("hf.co GGUF quant tag is unreadable", ollamaParamBillions("hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M"), null);
check("no tag at all", ollamaParamBillions("llama3"), null);
check("empty", ollamaParamBillions(""), null);
check("null safe", ollamaParamBillions(null), null);

console.log("\nNEVER BLOCKS A WORKABLE SETUP");
check("cloud configured is always capable", assessLoopCapability({ installedLocal: [], cloudConfigured: true }).capable, true);
check("  and says nothing", assessLoopCapability({ installedLocal: [], cloudConfigured: true }).warning, undefined);
check("a big local model is capable", assessLoopCapability({ installedLocal: ["qwen3:8b"], cloudConfigured: false }).capable, true);
check("  and says nothing", assessLoopCapability({ installedLocal: ["qwen3:8b"], cloudConfigured: false }).warning, undefined);
check("small models still RUN", assessLoopCapability({ installedLocal: ["qwen3:1.7b"], cloudConfigured: false }).capable, true);
check("unmeasurable models still RUN", assessLoopCapability({ installedLocal: ["llama3"], cloudConfigured: false }).capable, true);

console.log("\nWARNS WHERE IT SHOULD");
const small = assessLoopCapability({ installedLocal: ["qwen3:1.7b", "qwen:4b"], cloudConfigured: false });
check("small-only warns", Boolean(small.warning), true);
check("  names the LARGEST one it has", small.warning.includes("qwen:4b"), true);
check("  explains the real failure (stopping)", /STOP/.test(small.warning), true);
check("  offers the way out", /provider key/i.test(small.warning), true);
const unknown = assessLoopCapability({ installedLocal: ["llama3"], cloudConfigured: false });
check("unmeasurable warns but does not scold", Boolean(unknown.warning), true);
check("  admits it could not tell", /could not tell/i.test(unknown.warning), true);

console.log("\nTHE ONE CASE THAT IS GENUINELY NOT CAPABLE");
const none = assessLoopCapability({ installedLocal: [], cloudConfigured: false });
check("nothing at all is not capable", none.capable, false);
check("  and says what to do", /Ollama|provider key/i.test(none.warning), true);

console.log("\nTHRESHOLD BOUNDARY");
check(`exactly ${LOOP_CAPABLE_LOCAL_PARAMS_B}B passes`, assessLoopCapability({ installedLocal: [`x:${LOOP_CAPABLE_LOCAL_PARAMS_B}b`], cloudConfigured: false }).warning, undefined);
check("just under warns", Boolean(assessLoopCapability({ installedLocal: ["x:6.9b"], cloudConfigured: false }).warning), true);
check("one big among many small is enough", assessLoopCapability({ installedLocal: ["a:1.7b", "b:4b", "c:70b"], cloudConfigured: false }).warning, undefined);

console.log(`\n  ${pass}/${total} checks correct`);
process.exit(pass === total ? 0 : 1);
