# Metis Monetisation Plan

> Working doc, not a pitch deck. Written for Lachy to act on. Numbers are best-effort from
> July 2026 public pricing pages, sources cited inline. Where a number is a guess, it says so.

---

## 1. Positioning and the moat

Metis routes for quality, cost, and quota, and it prefers local. That single sentence is the
product and the business model at the same time.

Every AI coding tool that charges a subscription today is metering YOUR usage of cloud models
it doesn't own, either directly (Copilot, Cursor premium requests) or via a credit pool that
drains against provider token costs (Cursor, Traycer). None of them can offer a real free tier
that does full agentic work, because their free tier still costs them provider tokens.

Metis is different by construction: when the router picks a local Ollama model, the request
never leaves the machine and never costs Metis a cent. That means:

- **Local-first is free forever.** Not a trial, not a limited free tier, actually free, for as
 long as the user has a machine that can run a local model. This is a promise the app already
 keeps mechanically (nothing about local execution touches billing code) so it costs nothing
 to honor.
- **Local-first is private.** No prompt, no file, no image leaves the device unless the user's
 own routing policy sends it to the cloud. This is the pitch a compliance-conscious or
 privacy-conscious builder cannot get from Cursor, Copilot, or Traycer, all of which route
 every request through their own or a third-party cloud by default.
- **The wedge:** nobody metering BYO-cloud tools can match "free forever, runs 10 agents in
 parallel, never sends your code anywhere" because their entire cost structure assumes every
 token is billed. Metis's cost structure doesn't, because most tokens are free (local) by
 default and the app is architected to prefer them (see `docs/FABLE_PLANS.md` section 6 on
 token telemetry, which already shows users how much they saved by staying local).

**Standing rule: never paywall local.** Every tier below adds convenience or cloud access on
top of the same free local core. If a future feature idea requires gating local execution to
make the business model work, that is a sign the idea is wrong, not that the rule should bend.

---

## 2. Tiers

### Free - forever

- Full app: Orchestration graph, Build pipeline, Chat, Gallery, Graph View, Manager, Marketplace,
 Benchmark, Routines, To-Do board.
- Local-first routing on Ollama models, unmetered, unlimited.
- Bring-your-own cloud API keys for any provider (Anthropic, OpenAI, Gemini, DeepSeek, Groq,
 OpenRouter, NVIDIA NIM, etc.) - the user's own spend, on the user's own account, never
 touched or metered by Metis.
- Full marketplace: install and publish skills, MCP connections, presets.
- Local knowledge banks, local embeddings, local vision captioning.

This tier is not a funnel with training wheels. It is a complete, usable product. The
free/paid line is drawn at *convenience and scale*, never at *capability*.

### Pro - proposed **$14/month** (or $140/yr, ~17% off, matching the market's annual discount norm)

What Pro adds, without touching anything in Free:

- **Managed pooled cloud keys.** No key wrangling: Pro ships with Metis-managed API access to
 the major cloud models (Claude, GPT-5.6 tiers, Gemini, DeepSeek), billed against the user's
 token wallet balance (see §3) instead of a key they have to obtain and paste in. This is the
 single biggest onboarding-friction killer for non-technical or time-poor users.
- **Cloud-convenience routing.** The router is allowed to escalate to cloud automatically when
 a prompt needs it (large context, vision on a model the local rig can't run, higher reasoning
 tier) without the user having to have pre-configured a key for that exact provider.
- **Higher-parallelism managed agent fan-out.** Phase 5's N-agent fan-out (Nyx/Talos/Echo/
 Atlas/Juno) is free and unlimited for LOCAL agents. Pro raises the ceiling on how many agents
 can run concurrently against MANAGED cloud keys at once (local fan-out stays uncapped on
 Free - see the meter table in §4).
- **Cross-machine sync.** Conversations, presets, Graph View boards, and settings sync across
 devices.
- **Priority registry and publishing perks.** Faster review turnaround on marketplace PRs,
 a verified-publisher badge, featured-feed priority.

**Why $14/mo:** Cursor Pro is $20/mo (annual ~$16/mo) and gates unlimited *cloud* completions
behind it; GitHub Copilot Pro is $10/mo but is completions-only with no orchestration, no
graph, no multi-agent build pipeline; Copilot Pro+ is $39/mo for premium models. Traycer Lite
is $8/mo and Pro is $16/mo for a task-decomposition tool with no local-model story at all
(source: traycer.ai/pricing). Metis Pro sits between Traycer Pro and Cursor Pro, which is
fair: it does more than Traycer (full build pipeline, gallery, graph, manager, marketplace)
but competes on the fact that its BASE product is free forever in a way none of theirs are,
so it doesn't need to charge Cursor money to be worth it. $14 undercuts Cursor's list price
while matching what a power user already expects to pay for a coding-agent subscription.

*(Sources: Cursor pricing - lowcode.agency/blog/cursor-ai-pricing, cursor.com/blog/teams-pricing-june-2026;
GitHub Copilot - github.com/features/copilot/plans; Traycer - traycer.ai/pricing.)*

### Team - proposed **$14/user/month + a flat $20/mo workspace fee** (brief, optional, not launch-critical)

- Shared registry: a private/internal marketplace channel for a team's own skills, MCP
 connections, and presets, on top of the public one.
- Seats and an admin console: who has Pro, pooled key usage per seat, shared wallet balance
 with per-seat caps.
- Centralized billing (one invoice, not N individual subscriptions) - this is the single
 feature GitHub Copilot Business ($19/user/mo) and Cursor Business ($40/user/mo) both charge
 a premium for, so it's worth keeping cheap relative to them rather than a big markup.

Team is explicitly a "build when there's demand" tier, not a launch requirement. Note it here
so the Pro architecture (wallet, entitlement check) doesn't need a rework later to add seats.

---

## 3. The token wallet

For a Pro user who wants cloud access without managing their own API keys, Metis sells
prepacked token bundles ("wallet top-ups") that debit against real provider spend.

### Blended cost basis (July 2026 published rates)

| Model class | Input $/1M | Output $/1M | Notes |
|---|---|---|---|
| DeepSeek V4 Flash (cheap tier) | $0.14 | $0.28 | api-docs.deepseek.com/quick_start/pricing |
| Gemini Flash-Lite / Flash (cheap-mid tier) | $0.10–$0.30 | $0.40–$2.50 | ai.google.dev/gemini-api/docs/pricing |
| GPT-5.6 Luna (cheap-mid tier) | $1.00 | $6.00 | aipricing.guru/openai-pricing |
| Claude Sonnet (mid-premium tier) | $3.00 | $15.00 | platform.claude.com/docs/en/about-claude/pricing |
| GPT-5.6 Sol / DeepSeek V4 Pro (premium tier) | $0.435–$5.00 | $0.87–$30.00 | see table sources above |
| Claude Opus (top tier) | $5.00 | $25.00 | platform.claude.com/docs/en/about-claude/pricing |

Using a rough **3:1 input:output ratio** typical of coding/agentic workloads (lots of context
read, comparatively less generated), a blended "effective $/1M tokens" per class:

- **DeepSeek-class (cheap):** ≈ (0.75 × $0.14) + (0.25 × $0.28) ≈ **$0.18/1M blended**
- **Sonnet-class (mid):** ≈ (0.75 × $3.00) + (0.25 × $15.00) ≈ **$6.00/1M blended**
- **Opus-class (premium):** ≈ (0.75 × $5.00) + (0.25 × $25.00) ≈ **$10.00/1M blended**

### Margin and debit multipliers

Propose a flat **40% margin over blended provider cost** on the wallet (in line with
OpenRouter's card-purchase fee of 5.5% plus the reality that Metis is also paying for
managed-key infra, fraud/chargeback risk, and Stripe fees - a dev-tool reseller margin of
30–50% is normal; 40% is a reasonable starting point Lachy should tune post-launch).

To avoid losing money on expensive models, the wallet is NOT "buy X raw tokens, spend them on
anything" - it's a **dollar-denominated balance with a per-model debit multiplier**, so a
premium-model call debits the wallet faster than a cheap-model call for the same token count.
Concretely: wallet dollars = provider cost × 1.4 (the margin), and a per-model multiplier
table (auto-derived from each model's published rate, refreshed whenever the model catalog
updates) converts "tokens used" into "wallet dollars debited" at call time. This is the same
shape as GitHub Copilot's AI Credits system (1 credit = $0.01, different models draw down
credits at different rates) - proven UX pattern, cite: usagebox.com/articles/github-copilot-usage-based-billing-2026.

### Worked bundle examples

| Bundle price | Wallet value (after 40% margin) | DeepSeek-class tokens | Sonnet-class tokens | Opus-class tokens |
|---|---|---|---|---|
| $10 | $7.14 raw-cost budget | ≈ 40M tokens | ≈ 1.2M tokens | ≈ 0.7M tokens |
| $25 | $17.86 raw-cost budget | ≈ 99M tokens | ≈ 3.0M tokens | ≈ 1.8M tokens |
| $50 | $35.71 raw-cost budget | ≈ 198M tokens | ≈ 6.0M tokens | ≈ 3.6M tokens |

(Math: wallet raw-cost budget = bundle price ÷ 1.4. Tokens = raw-cost budget ÷ blended
$/1M for that class, ×1,000,000. These are illustrative - a real user's mix is blended
across classes, which is exactly why the multiplier system exists instead of a single
token count.)

**How a debit maps to actual spend:** every managed-key call already returns real provider
usage (`usage.input_tokens` / `usage.output_tokens` for Anthropic/OpenAI/DeepSeek,
`prompt_eval_count`/`eval_count` for Ollama - this plumbing is already speced in
`docs/FABLE_PLANS.md` §6b for the telemetry heatmap). The same real-usage numbers, multiplied
by that model's published rate and the 1.4x margin, are what gets subtracted from the wallet
balance. No estimation for wallet debits once real usage is available; fall back to the
chars/4 heuristic only for pre-flight balance checks (warn before a call that would overdraw).

**Existing telemetry does most of the UX work for free.** The home-tab heatmap and "tokens
saved via local routing" line (FABLE_PLANS §6) already shows users, per day, how many tokens
they used and what it would have cost in the cloud. The wallet just needs one more stat next
to it: "wallet balance: $X, ≈Y calls left at your current mix" - reusing the same rollup
instead of building new tracking.

---

## 4. What we meter vs never meter

| Path | Metered? | Why |
|---|---|---|
| Local model (Ollama), any tier | **Never** | No provider cost is incurred; this is the core promise. |
| Cloud model via the user's own API key | **Never** | The spend is between the user and their provider; Metis never sees or touches it. |
| Cloud model via Metis-managed pooled key / wallet | **Metered** | Metis is fronting real provider spend on the user's behalf; this is the only place money changes hands. |
| Local agent fan-out (Phase 5, N sub-agents) | **Never** | Same as any local call - free and uncapped on every tier. |
| Managed-key agent fan-out at high parallelism | **Metered + Pro-gated concurrency cap** | Each sub-agent still debits the wallet per real usage; Pro just raises how many can run at once. |

The dividing line is exactly "does Metis pay a provider for this call." That's the only
honest place to meter, and it keeps the free promise from being marketing-speak: a user who
never touches managed keys or the wallet can genuinely never be billed, no matter how hard
they use the app.

---

## 5. Rails and implementation sketch

This is a sketch for scoping, not a spec to build against this round - no payment code ships
in this pass.

- **Stripe** for both subscription billing (Pro/Team) and wallet top-ups (one-time payment
 intents). Stripe Billing handles the recurring Pro charge; Stripe Checkout or Payment
 Element handles wallet top-up purchases; Stripe Customer Portal covers cancel/upgrade/
 invoice history without Metis building its own billing UI.
- **Entitlement check:** a minimal license/session token issued after a successful Stripe
 webhook (`checkout.session.completed`, `customer.subscription.updated/deleted`), stored
 server-side (a small Metis account service, not in the Electron app itself) and checked
 by the desktop app on startup and periodically. Local execution NEVER calls this check - 
 it only gates managed-key routing and Pro-only UI surfaces (sync, higher fan-out cap,
 registry perks).
- **Wallet balance** lives server-side (same small account service, not client-trusted
 local storage - a wallet balance the client could edit locally would be a trivial fraud
 vector). The desktop app reads a cached balance for UI display and calls a debit endpoint
 after each managed-key provider call completes with real usage numbers.
- **Managed keys themselves** never touch the client. Metis holds its own pooled provider
 keys server-side; the desktop app proxies managed-cloud requests through a thin Metis
 relay that debits the wallet and forwards to the provider. This also means Metis can swap
 or rotate the underlying provider keys without any client update.
- **Abuse/fraud considerations:**
 - Rate-limit managed-key relay calls per account, independent of wallet balance, to stop a
 compromised or shared account from burning through pooled capacity.
 - Wallet top-ups follow normal Stripe fraud tooling (Radar); chargebacks should suspend
 the wallet (not delete balance) pending resolution.
 - Because BYO-key usage is never metered, there's no incentive for anyone to defraud that
 path - the wallet is the only surface with fraud exposure, which keeps the attack
 surface small and matches OpenRouter's own model (they only take a cut on the credit
 purchase step, never on inference itself - source: openrouter.ai/docs/faq).
 - Cap free-trial-style managed-key access (if offered) tightly, or skip trials entirely
 and let the BYO-key free tier be the trial.

---

## 6. Competitive scan

| | **Metis** | **Cursor** | **Traycer** | **OpenRouter** |
|---|---|---|---|---|
| Pricing model | Free forever (local) + $14/mo Pro (managed cloud + convenience) + pay-as-you-go wallet | Free (limited) / $20/mo Pro / $60 Pro+ / $200 Ultra, credit pool drains on cloud model choice | Free (open-source projects) / $8/mo Lite / $16/mo Pro, credit bundles from $10 | No subscription; pure pass-through token pricing + 5.5% fee on credit purchases |
| What you get | Full orchestration app: visual pipeline, multi-agent build, gallery, graph, manager, marketplace - all cloud AND local | AI code editor, agent mode, tab completion | Task decomposition / planning layer on top of your own editor | Just a routing API + unified billing across ~300 models |
| Local model support | **First-class, unmetered, unlimited, on every tier** | None - always cloud | None - always cloud | N/A, it's a cloud router by design |
| Privacy story | Local execution never leaves the device by default | All requests go through Cursor's cloud | All requests go through Traycer's cloud | All requests go through whichever provider you route to |
| Where Metis wins | Local-first-is-actually-free + full pipeline ownership: nobody else can offer unlimited free agentic work because their cost structure assumes every token is billed | - | - | - |

Metis is not really competing with OpenRouter (that's closer to a supplier Metis routes
through for cloud calls) - it's listed because the wallet pricing model borrows OpenRouter's
"pass-through + fee on top-up" shape rather than reinventing one.

---

## 7. Unit economics - a worked example

**Scenario:** a Pro subscriber ($14/mo) who runs mostly local but escalates to cloud a few
times a day via managed keys - a realistic "power user who doesn't want to manage keys"
profile.

Assume: 20 cloud escalations/day, 26 days/month = 520 calls/month. Assume each call averages
3,000 input + 1,000 output tokens (a typical single-stage build or chat turn), and the mix is
60% DeepSeek-class, 30% Sonnet-class, 10% Opus-class (router prefers cheap first, escalates
only when needed).

Per-call blended cost (weighted):
- DeepSeek-class: (3,000 × $0.14 + 1,000 × $0.28) / 1,000,000 ≈ $0.00070/call
- Sonnet-class: (3,000 × $3.00 + 1,000 × $15.00) / 1,000,000 ≈ $0.024/call
- Opus-class: (3,000 × $5.00 + 1,000 × $25.00) / 1,000,000 ≈ $0.040/call

Weighted average cost/call ≈ (0.6 × $0.0007) + (0.3 × $0.024) + (0.1 × $0.040)
≈ $0.00042 + $0.0072 + $0.0040 ≈ **$0.0116/call**

Monthly provider cost ≈ 520 × $0.0116 ≈ **$6.05/month** in raw provider spend for a fairly
active user.

**Margin check:** $14/mo subscription − $6.05 provider spend (if that entire usage were
covered by the Pro allowance rather than wallet top-ups) ≈ **$7.95/mo gross margin per user**
before Stripe fees (~2.9% + $0.30/txn) and infra. That's roughly **57% gross margin** at this
usage profile, which is healthy for a subscription business and leaves room for heavier users
before the wallet top-up mechanism needs to kick in as the pressure valve.

**Break-even sketch:** if Pro subscriptions need to cover a shared account-service + Stripe +
support cost of roughly $2–3/user/month in fixed overhead (rough SaaS-infra rule of thumb for
a small team), the model is profitable per-user as long as average managed-cloud usage stays
under roughly ($14 − $2.50) / $0.0116 ≈ **~990 calls/month**, i.e. about double the assumed
usage in this example. Above that, the wallet top-up (metered separately, its own 40% margin)
takes over rather than the flat subscription absorbing unlimited cloud usage - this is the
mechanism that keeps a single power user from turning Pro into a loss leader.

---

## 8. Risks and open questions (for Lachy to decide)

- **Final Pro price.** $14/mo is a reasoned starting point (undercuts Cursor, matches
 Traycer+headroom for the extra surface area) but untested against real willingness-to-pay.
 Consider a launch price with an explicit "early adopter, locked forever" hook.
- **Wallet margin %.** 40% is a starting assumption, not measured. If Stripe fees + fraud +
 infra run higher than expected, the margin may need to be 50%+ to stay healthy; if
 competitive pressure from OpenRouter's near-zero markup shows up, it may need to come down.
- **Wallet at launch or later?** The wallet adds real payments-infra scope (Stripe, fraud,
 a server-side balance) that a bare Pro subscription doesn't. Option: ship Pro first (simpler,
 one Stripe Billing integration, no per-call metering), defer the wallet to a second release
 once there's demand signal for "I want cloud but don't want to paste in a key."
 Managed-key routing without a wallet could initially just be "Pro includes a fixed monthly
 cloud allowance" (simpler mental model, same accounting underneath) before building the
 pay-as-you-go top-up UI.
- **Provider cost volatility.** Every price in this doc is a July 2026 snapshot; DeepSeek,
 Gemini, and OpenAI have all cut prices repeatedly through 2025–2026 and could again. The
 per-model debit multiplier table needs to be re-derived from the live model catalog
 (`catalog/models.json` in metis-registry) rather than hardcoded, so a provider price cut
 doesn't silently blow the margin on old debits and a price hike doesn't quietly undercharge.
- **Team tier scope.** Priced here as a placeholder ($14/user + $20/workspace) with no real
 validation; treat as "don't build yet, but don't architect against it either."
- **Does "priority registry perks" for Pro create a two-tier marketplace that undermines the
 community-first registry story?** Worth a gut check before launch - the registry pitch in
 the README is explicitly "GitHub-native, reviewed and merged by pull request," and paying
 for faster review could read as pay-to-win if not handled carefully (e.g. frame it as
 faster REVIEW turnaround, never as bypassing review).
