# Tests

```bash
npm run build   # the suites run against dist-electron, so build first
npm test
npm test loop   # run only suites whose filename matches
```

## What these are

Plain Node assertions against the **compiled output** in `dist-electron`, run one
suite per process by `tests/run.mjs`. No test framework, because a dependency, a
config file and a watch mode would be a lot of ceremony for eight files of
assertions.

They are **entirely offline**. Nothing here calls a provider, opens a socket, or
reads an API key, so running them costs nothing. That is deliberate: a suite you
hesitate to run is a suite that does not get run.

## The rule that matters

**Every suite imports the real shipped function.** None of them re-implement or
paste a copy of what they test.

This was not always true. Several of these began as ad-hoc scripts that pasted a
regex inline and asserted against it, which meant they agreed with themselves no
matter what the app actually did. `isEditIntent`, `isPathInside` and
`clampPermissionMode` were lifted out of `main.ts` into
`src/shared/intent-and-paths.ts` specifically so the tests could reach them. If
you add a suite, import from `dist-electron` via `fromBuild()` in
`tests/harness.mjs`. Do not copy the logic across.

A test that cannot fail when the code breaks is decoration.

## Confirming they still bite

Worth doing occasionally, and it takes a minute: edit a function in
`dist-electron` to reintroduce a bug, run `npm test`, and check the right suites
go red. Rebuild afterwards.

Both bugs below were real, and this is how these suites were validated:

- rank `edits` below `auto` in `PERMISSION_WRITE_FREEDOM` and suite 06 fails
- remove the trailing-separator guard in `isPathInside` and suite 08 fails

## The suites

| Suite | Covers | Why it exists |
| --- | --- | --- |
| `01-loop-decision` | `extractLoopDecision`, delay clamping, wake prompts | A loop that misreads a decision keeps spending money unattended. Every ambiguous input must resolve to STOP. |
| `02-loop-continuation` | `decideLoopContinuation` | Its first version took the FIRST continue-or-stop line, and the prompt lists CONTINUE above STOP, so an echoed menu beat a real answer. |
| `03-loop-capability` | `assessLoopCapability`, `ollamaParamBillions` | Must never block a local-only setup, which is the case the feature exists to serve. |
| `04-loop-command` | the `/loop` grammar | A typo becomes an autonomous run doing the wrong thing, so malformed input must be refused before enter, never silently defaulted. |
| `05-loop-store-races` | the serialised mutation pattern | Asserts the OLD read-then-write shape still REPRODUCES the lost-Stop race. If that starts passing, the test has stopped exercising the race and the rest is meaningless. |
| `06-permission-clamp` | `clampPermissionMode` | Decides what an unattended loop may do. Checks all 25 request/ceiling pairs for escalation. |
| `07-edit-intent` | `isEditIntent` | Missing refactor vocabulary once sent an edit to plain chat, where the model invented a wrong key name instead of reading the file. |
| `08-path-containment` | `isPathInside` | A bare `startsWith` made `C:\project-secrets` look like it was inside `C:\project`. |

## What is not covered

Most of the app. These cover pure, high-consequence logic: loop decisions,
permissions, path containment, routing intent. Anything needing Electron, a
provider, or the filesystem is exercised by the CLI harness
(`npm run cli -- doctor | chat | build | loop`) by hand, not here.
