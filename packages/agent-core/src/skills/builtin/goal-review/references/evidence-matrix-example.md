# Evidence matrix example

| Obligation | Current artifact | Fresh evidence | Edge case | Status |
| --- | --- | --- | --- | --- |
| Resource is bounded | package reader limit | focused test exits 0 and asserts equal/above | exact limit and one byte above | supported |
| Winning source is atomic | resolver implementation | precedence and missing-resource tests | invalid high-priority package | supported |
| Compiled artifact contains resources | static manifest | standalone binary byte comparison | non-UTF-8 asset | supported |
| Existing user packages still load | no migration exists | none | old single-file shape | unsupported, intentional breaking change |

For every row, identify the governing acceptance text before looking for evidence. “Current artifact” locates the implementation; it is not proof. “Fresh evidence” names the exact command, inspection, or runtime observation and material result. The edge case should be capable of falsifying the claim.

Use these evidence categories consistently:

- **supported:** fresh evidence covers the complete obligation and material edge path;
- **partially supported:** only part of the obligation or one layer is proven;
- **unsupported:** the obligation is not implemented or evidence demonstrates failure;
- **contradicted:** implementation or behavior conflicts with the obligation;
- **unverifiable:** required evidence is inaccessible or would require authority the Reviewer lacks.

After building the matrix, trace cross-row risks that a per-file review misses: source selection into activation, activation into Prompt/tool output, persistence into restart, or implementation into compiled delivery. Verification performed before the final material change is stale.

Use `supported`, `partially supported`, `unsupported`, `contradicted`, or `unverifiable` as prose evidence categories. The Lead, not this table, decides Goal status.
