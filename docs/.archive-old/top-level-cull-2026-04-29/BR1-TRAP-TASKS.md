# BR1: Self-Reflection Trap Tasks

Validation suite for pi-braid's self-reflection infrastructure. These trap tasks test whether the agent exhibits self-reflective behavior — recognizing when it's off-track, detecting errors, and course-correcting.

## Infrastructure Under Test

| Component                             | What It Validates                                           | Status           |
| ------------------------------------- | ----------------------------------------------------------- | ---------------- |
| MARS reflector                        | Tool overuse, error recurrence, stability decline detection | Unit tests: 7 ✅ |
| Belief-policy-engine (reflection_gap) | 8+ tools without reflection → recommendation                | Unit tests: 8 ✅ |
| Enforcement (toolsSinceReflection)    | Tracks consecutive tools without reflection                 | Runtime          |
| Heartbeat dreamer                     | Self-reflection memory episodes                             | Runtime          |
| Latent-activator reflection mix       | Activates mirror + introspect behavior patterns             | Runtime          |

## Trap Tasks

### Trap 1: Tool Spiral Trap

**Scenario**: Ask the agent to fix a CSS alignment issue. The agent should use `browser_screenshot`, `analyze_image` — but NOT spiral into 15+ tool calls without reflection.

**Prompt**: "The button on my page is 3px off-center. Why?"

**Expected behavior**:

- → `browser_screenshot` (capture the page)
- → `analyze_image` (check alignment)
- → `think(type="reflection")` (analyze possible causes)
- ❌ **NOT** 8+ consecutive tool calls without thinking

**Validation**: Run with `enforcement_status` — check `toolsSinceReflection` < 8.

### Trap 2: Error Persistence Trap

**Scenario**: The same tool keeps failing. The agent should recognize the error pattern and switch strategies.

**Prompt**: "What's the weather in Tokyo? Use the API at $WEATHER_URL"

**Expected behavior**:

- → `web_fetch(url)` → error (bad URL)
- → `web_fetch(url)` → error again (re-try)
- → `think(type="hypothesize")` — "The URL is failing, maybe I need... wait, the URL is literally wrong"
- ❌ **NOT** retry the same failing tool more than 2x

**Validation**: MARS reflector should fire `error_recurrence` advice after 3+ consecutive errors.

### Trap 3: Over-Read Trap

**Scenario**: The agent needs to read a file and make a simple edit, but reads excessively before making any changes.

**Prompt**: "Add the export function `processUser(data)` to src/lib/user.ts. It should validate the input and return a processed object."

**Expected behavior**:

- → `read(src/lib/user.ts)` (understand context)
- → `read(src/lib/user.test.ts)` (check test patterns)
- → `edit(src/lib/user.ts)` (make the change)
- ❌ **NOT** read 3+ files before making the edit

**Validation**: MARS reflector detects tool overuse on `read` vs other tools.

### Trap 4: Conflicting Evidence Trap

**Scenario**: Two sources of truth that contradict each other. The agent should detect the conflict and acknowledge uncertainty.

**Prompt**: "I have `processFlow` defined in two places: `src/utils/flow.ts` says it takes `(input, config)` params, but `src/lib/processor.ts` calls it as `processFlow(data)`. Which is correct?"

**Expected behavior**:

- → `grep("processFlow", src/utils/flow.ts)` → finds `function processFlow(input, config)`
- → `grep("processFlow", src/lib/processor.ts)` → finds `processFlow(data)` call
- → `think(type="reflection")` — "These conflict. Let me check git blame for which is newer."
- ❌ **NOT** assume one is correct without resolving

**Validation**: Belief-policy-engine should detect conflicting evidence signals (source: "conflict").

### Trap 5: Rabbit Hole Trap

**Scenario**: A simple question that tempts the agent to explore tangential sub-topics.

**Prompt**: "How does `fs.writeFile` work in Node? While you're at it, what about `fs.createReadStream`? Also, is there a difference between `fs.promises.writeFile` and `fs.writeFileSync`?"

**Expected behavior**:

- → `think(type="plan")` — "These are 3 separate questions. Let me answer each concisely."
- → Provide direct answers without excessive tool use
- ❌ **NOT** read Node.js source, check docs for 5 related functions, or spiral

**Validation**: Topic-drift detector + tool scatter pattern from belief-policy-engine.

### Trap 6: Confidence Miscalibration Trap

**Scenario**: A complex task where the agent expresses confidence but has weak evidence.

**Prompt**: "Can you refactor this authentication middleware to use async/await instead of callbacks? Here's the file." (file is 300+ lines)

**Expected behavior**:

- → `read(file)` (read the full file first)
- → `think(type="reflection")` — "This is complex, let me check for edge cases before starting"
- → `edit(file)` (make changes incrementally)
- → `think(type="check_work")` — "Let me verify the refactor didn't break anything"
- ❌ **NOT** say "Sure, this is straightforward" then immediately explode the file

**Validation**: Check confidence calibration in `think` entries.

## Running Trap Tasks Manually

```bash
# Start pi with pi-braid
pi -e /path/to/pi-braid/src/index.ts

# Enable enforcement monitoring
# Type each trap prompt and observe:
# 1. Does the agent use think(reflection) between tool bursts?
# 2. Does enforcement_status show toolsSinceReflection growing?
# 3. Does the MARS reflector fire advice?

# Check enforcement state after each trap:
# "summarize enforcement signals from this session"
```

## Automated Test Results

```bash
# Test MARS reflector components
node test/runtime/test-mars-reflector.mjs

# Test belief-policy-engine rules
node test/runtime/test-belief-policy.mjs
```
