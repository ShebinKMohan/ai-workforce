# Office artwork

`public/assets/office-clean.png` preserves the user's original artwork, copied byte-for-byte from the selected UI at `127.0.0.1:4318` and the earlier retained `web/office` copy. SHA-256: `9da8e29a1c566422c2238630e227528460010b12721a89b7f41c4f3e2e008035`. The original source folder was not edited. The active illustration is now the inward-facing derivative described below, following the user's subsequent request to orient every department's desks and chairs toward the central Control center.

`public/assets/office-empty.png` is a retained empty-seat variant made with the built-in imagegen tool on 12 September 2026. Both images are 1402 × 1122. SHA-256 of the variant: `71e374db18be300ea7edc0fca94d3f9063317d2bbb5373eb1899bdfb09620d51`. The active renderer instead uses the matched inward-facing pair below. This avoids presenting decorative people as configured employees and avoids opaque paint-like covers.

The edit was inspected before integration. It removes the 24 outer people, preserves the central scheduler illustration and keeps the original scene coordinates. The original asset is never overwritten. This is an illustrative representation of saved configuration; it is not evidence of a model executing.

## Original empty-seat edit prompt

Use case: precise-object-edit. This image is the edit target, a fixed-coordinate UI background (1402x1122). Create an EMPTY-SEAT VARIANT ONLY. Remove the 24 people sitting at the four desks on each of the six outer islands. Replace their bodies naturally with empty office chairs. Keep the ONE central coordinator person unchanged. CRITICAL: preserve EXACT canvas framing, the position and size of every island, walkway, desk, chair, monitor, floor edge, shadow, colors, lighting, perspective and all background pixels as closely as possible. Do not move, scale or redesign any object. Do not crop, add padding, rotate, change composition, or add new objects. Do not remove desks or monitors. Natural clean inpainting where a person was, no paint patches, blurring or veils. This must align with the original when layered so configured employees can be overlaid at their original exact positions. No text. Keep the same aspect ratio and ideally exact 1402x1122 size. Original detailed soft isometric 3D artwork must be retained.

## Active inward-facing artwork

The user requested all four workstations on each department island face the central Control center, then specifically called out opposite-facing employees and incorrect monitor faces. Built-in imagegen edits preserved the six-island composition, central desk, walkways, palette and style while rotating the workstations. The active illustration is therefore an intentional derivative, not a byte-identical original.

| File | Purpose | SHA-256 |
| --- | --- | --- |
| `office-inward.png` | Active occupied artwork | `a1635c26144fc0c93ef64dd7b9f107c0f5492c65eeb2615fd0bca39ae366ee03` |
| `office-inward-empty.png` | Matched active empty-seat artwork | `8fba532540cf38f937d3dae2334a0f6d56d0e02ecdb5561d4c02aa1658f9a2d1` |

Both are 1402 × 1122 PNGs generated on 12 September 2026. Original generated files remain in this task's Codex generated-images directory. Final occupied output: `exec-30335647-8e96-4839-9246-2ceb5043a53b.png`. Matched empty output: `exec-0398f07d-db71-4a88-96bc-ba19aea52ef9.png`. Rejected common-direction drafts remain outside the served repository.

The final occupied correction prompt targeted only the two upper blue islands: place every upper-left department chair/employee on the upper-left outward side and each monitor on the lower-right inward side; mirror that for the upper-right department. Every employee sits farther from the center than their monitor. The camera must see dark rear monitor housings on these eight stations, with screens facing their employees. Leave the four lower/side departments and central desk unchanged; preserve four workstation centers per island, framing, lighting, colors and 1402 × 1122 dimensions.

The matching empty edit used that final occupied image and requested removal of only the 24 outer people, keeping the central person unchanged. Preserve all workstation positions and directions, every monitor front/back, furniture, islands, walkways, shadows and lighting. Keep the upper eight monitors' dark backs. Reconstruct only exposed chair seats/backs, with no crop, padding, new objects, flat covers or blur. Keep exact canvas dimensions for aligned CSS compositing.

These are visual derivatives rather than deterministic pixel edits. Individual assets and the assembled live Office are inspected together when changing patch bounds or workstation positions. Labels, counts, tasks, routing and actions use actual workspace records. The central illustration represents the scheduler, not an additional model employee.
