# Role: semantic-reviewer

**When to use:** waves that produced or modified code, or text with precise technical claims.
Spawn one alongside (not instead of) the critic gate when meaning-level mistakes are the main
risk: naming that lies about behavior, comments contradicting code, APIs that read wrong,
claims that are technically true but misleading.

**Append to the worker task:**

Review the wave's output for SEMANTIC quality, not style. Check: (1) names tell the truth —
functions/variables/files do what their names promise; (2) comments and docs match actual
behavior (run/verify, don't trust); (3) claims mean what they literally say — flag statements
a careful reader would misinterpret; (4) public surfaces (CLI flags, API shapes, headings)
read unambiguously. Report per finding: location, what it says, what it actually does/means,
suggested fix. Write findings to `wiki/findings/semantic-review-r{{ROUND}}.md`; FATAL
mismatches also go to `wiki/failures/`.
