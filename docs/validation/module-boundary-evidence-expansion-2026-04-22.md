# Module-Boundary Evidence Expansion Validation

Date: 2026-04-22
Tranche: `2026-04-22-module-boundary-evidence-expansion`

## Tranche-2 focus

Tranche 2 targeted the remaining payload mismatch from tranche 1:

- fixture-scale glue-aware projection already existed
- repo-scale projection still produced zero meaningful `projected-through-glue` relationships
- the live gap was concentrated around shared/root glue controllers that mediated real module behavior but did not persist module-target evidence into the canonical overlay

## What changed

- `src/scanner/associations/framework/laravel-boundary-evidence.ts`
  - shared glue sources such as root/shared controllers and providers now persist real module-target evidence when they point into owned modules
  - this closes the prior blind spot where `laravel-boundary-evidence` only emitted edges if the source file was already inside an owned module
- `src/experts/module-boundary-analysis.ts`
  - projection now traverses multi-step glue transit instead of only one `owned -> glue -> owned` hop
  - traversal can bridge between glue symbol and glue file nodes in the same shared controller file so live paths such as `module consumer -> surface -> shared controller symbol -> shared controller file -> owned module evidence` survive
  - same-file glue bridging is intentionally limited to glue `file`/`symbol` pairs; it does not treat every surface in `routes/*.php` as siblings, which would create the fake hub behavior forbidden by R4/R5
- focused tests were extended to cover:
  - glue-origin evidence persistence
  - multi-step glue projection through a shared controller file

## Calibration status

No weighting thresholds changed in tranche 2.

The calibration delta is structural rather than numeric:

- glue-origin evidence is now eligible to persist when the source is classified as shared glue and the target is an owned module
- projection now supports multi-step glue transit plus constrained same-file glue bridging for shared controller symbol/file pairs

Payload calibration notes under `CORPUS` were not writable from this sandbox, so this delta is recorded here instead of in `CALIBRATION-NOTES.md`.

## Focused validation

Commands run:

- `npm run build`
- `npm test -- src/scanner/associations/__tests__/laravel-boundary-evidence.test.ts`
- `npm test -- src/experts/__tests__/module-boundary-analysis.test.ts`
- `npm test -- src/cli/__tests__/overlay-boundaries-cli.test.ts`

Result:

- all focused tranche tests passed
- build passed

## Repo-scale validation

### acme Core

- Repo: `/path/to/auctic-core/vcs`
- Rebuild date: 2026-04-22
- Trust: `overlay-complete`
- Rebuild result:
  - `782` surfaces
  - `8850` symbol nodes
  - `505` overlay engine edges from resolver pass before detector/projection expansion

Boundary comparison:

- projected mode aggregate count: `82`
- direct-only aggregate count: `79`
- aggregates with non-zero projected weight: `4`
- projected-only aggregates: `3`

Meaningful projected relationships now present:

- `CatalogAdmin -> Listing`
- `MediaAdmin -> Listing`
- `UserListingNotes -> Listing`
- `LiveEventManagement -> Listing` gained projected support in addition to direct evidence

Representative projected path shape:

- consumer module file
- `calls_surface` into a root/admin route surface
- `handled_by` into shared `src/Http/Controllers/Api/ListingController.php`
- same-file glue bridge from controller symbol to controller file
- glue-origin `emits_event` evidence into `src/Module/Listing/Events/SoldListingUpdated.php`

Representative projected sample provenance:

- route/surface transport evidence from consumer propagation
- explicit `handled_by` controller resolution
- persisted glue-origin boundary evidence from `laravel-boundary-evidence`
- explicit `same-file glue bridge via src/Http/Controllers/Api/ListingController.php`

Probe outcomes:

- still connected with direct overlay-backed evidence:
  - `ExternalApi`
  - `Report`
  - `MobileApi`
  - `ListingImport`
  - `Webhooks`
  - `ListingCategories`
  - `ListingQR`
  - `ListingBulkMove`
- improved via projected-through-glue:
  - `CatalogAdmin -> Listing`
  - `MediaAdmin -> Listing`
  - `UserListingNotes -> Listing`
- still missing from aggregates in this cut:
  - `Analytics`
  - `Permission`

Assessment:

- the tranche-2 architectural gap is fixed on acme Core
- projection is now real at repo scale
- the recovered paths remain explainable and transit-preserving instead of collapsing into a `Global` or root-route hub

### acme Atlas

- Repo: `/path/to/auctic-atlas/vcs`
- Rebuild date: 2026-04-22
- Trust: `degraded-overlay`
- Rebuild result:
  - `20` surfaces
  - `0` symbol nodes
  - `7` resolver edges

Boundary result:

- aggregate count: `6`
- projected relationships: `0`

Representative relationships remained:

- `DataLake -> InfrastructureVisibility` `depends-on`
- `InfrastructureVisibility -> ClientProvisioning` `interacts-with`
- `DataLake -> ClientProvisioning` `adjacent-to`

Assessment:

- Atlas still does not provide a useful projection benchmark because the rebuild remains `degraded-overlay`
- tranche 2 was not tuned against Atlas
- the second-repo pass stays behaviorally stable, but it does not materially expand validation confidence beyond confirming the known degraded-overlay constraint

## Requirement traceability

- `R4` / `R5`: fixed by making projection survive multi-step glue transit without promoting route files or shared controllers into dominant module nodes
- `R1` / `R12`: fixed by persisting glue-origin evidence into the canonical overlay substrate instead of export-only logic
- `R2` / `R6` / `R7`: preserved because projected paths remain distinct, transit provenance is retained, and operator-facing kinds are still `depends-on` / `interacts-with` / `adjacent-to`
- `R10` / `R11`: validated on acme Core isolate probes and re-checked on acme Atlas without overfitting
- `R14`: calibration delta recorded explicitly here
- `R15`: focused tests and build passed

## Open mismatches

- `Analytics` and `Permission` still do not appear in acme Core aggregates
  - no weak heuristics were added to force them in
  - follow-up should start by checking whether their real coupling is still hidden behind shared services, policy/permission infrastructure, or evidence families not yet modeled strongly enough
- current repo-scale projected paths are concentrated around the shared `ListingController` flow
  - this is a real improvement, not fake density
  - but it also shows that shared-controller recovery is still sparse outside the strongest Listing-adjacent glue flows
- acme Atlas remains limited by `degraded-overlay`

## Tranche-3 candidates

- recover additional shared-controller and policy/permission flows for modules still missing from acme Core, especially `Analytics` and `Permission`, only where persisted evidence is real
- consider broader shared-controller service/request/resource recovery where existing glue controllers mediate module-owned behavior but still do not emit enough owned-target evidence
- improve Atlas symbol recovery before expecting projection improvements there

## Tranche-3 focus

Tranche 3 reviewed the two remaining high-salience missing modules from tranche 2:

- `Analytics`
- `Permission`

The task was not to force them into the graph.

The task was to determine whether acme Core contains real module-to-module evidence for them that Lux was still failing to recover.

## Tranche-3 changes

- `src/experts/__tests__/module-boundary-analysis.test.ts`
  - added a regression case that keeps self-contained module surfaces out of module aggregates when they only traverse their own route/controller glue
  - this protects the payload rule against fabricating cross-module coupling from route declaration, handling, and same-module UI/service calls alone

## Tranche-3 calibration status

No scoring or threshold changes were made in tranche 3.

The investigation showed that changing calibration here would be the wrong move:

- `Analytics` is not being hidden by projection thresholds
- `Permission` is not being hidden by reinforcement thresholds
- both modules currently lack persisted owned-module cross-boundary evidence in acme Core

Payload calibration notes under `CORPUS` remain outside the writable sandbox, and tranche 3 did not produce a calibration delta that needed separate recording.

## Tranche-3 focused validation

Commands run:

- `npm run build`
- `npm test -- src/experts/__tests__/module-boundary-analysis.test.ts`
- `npm test -- src/scanner/associations/__tests__/laravel-boundary-evidence.test.ts`
- `npm test -- src/cli/__tests__/overlay-boundaries-cli.test.ts`

Result:

- focused tranche tests passed
- build passed

## Tranche-3 repo-scale validation

### acme Core

- Repo: `/path/to/auctic-core/vcs`
- Rebuild date: 2026-04-22
- Trust: `overlay-complete`
- Rebuild result:
  - `782` surfaces
  - `8850` symbol nodes
  - `505` overlay engine edges from resolver pass before detector/projection expansion

Boundary comparison:

- projected mode aggregate count: `82`
- direct-only aggregate count: `79`
- aggregates with non-zero projected weight: `4`
- projected-only aggregates: `3`

`Analytics` review:

- persisted module-owned evidence remained limited to:
  - route declaration
  - route handler mapping
  - same-module typed request validation
- no cross-module owned consumer of `Analytics` routes or services was found in acme Core
- no cross-module imports of `acme\\Core\\Module\\Analytics\\...` were found outside `CoreServiceProvider` and the module itself
- the module’s deeper runtime work is mostly:
  - internal job dispatch
  - cache/bus infrastructure
  - global models and DB tables
- result: `Analytics` remains structurally absent from module aggregates in this repo cut

`Permission` review:

- persisted module-owned evidence remained limited to:
  - route declaration
  - route handler mapping
  - same-module request validation
  - same-module JS service calls to Permission-owned admin API surfaces
- no cross-module imports of `acme\\Core\\Module\\Permission\\...` were found outside `CoreServiceProvider` and the module itself
- the broader permission system in acme Core is implemented mostly through global/shared infrastructure rather than through the `Permission` module:
  - `src/Enums/UserPermissionEnum.php`
  - `acme\\Core\\User`
  - Spatie role/permission models and registrar
  - shared permission utilities consumed by other modules
- result: `Permission` remains structurally absent from module aggregates in this repo cut

Assessment:

- tranche 3 did not recover `Analytics`
- tranche 3 did not recover `Permission`
- this is currently an honest absence, not a remaining projection bug like tranche 2
- no weak ownership remap was added from global permission infrastructure into the `Permission` module
- no heuristic remap was added from global models or passive external surfaces into `Analytics`

### acme Atlas

- not re-run in tranche 3
- rationale:
  - the tranche-3 question was an acme Core isolate review for two specific modules
  - Atlas remained `degraded-overlay` in tranche 2 and does not currently expose enough symbol-backed structure to validate this missing-module question meaningfully

## Tranche-3 requirement traceability

- `R2` / `R6` / `R7`: preserved by refusing to upgrade self-contained route/controller glue into fake cross-module truth
- `R4` / `R5`: preserved because no additional hub promotion or global ownership remap was introduced
- `R10` / `R11`: satisfied by explicit acme Core isolate review of `Analytics` and `Permission`
- `R14`: no calibration delta; the key outcome is the explicit finding that these modules are presently absent for structural reasons, not because of hidden weights
- `R15`: focused tests and build passed

## Tranche-3 conclusion

- recovered: none
- partially recovered: none
- still structurally absent:
  - `Analytics`
  - `Permission`

Why:

- `Analytics` is currently a passive module with self-contained routes/services and global-model or infrastructure dependencies, but no persisted owned-module cross-boundary path in acme Core
- `Permission` currently owns a role-management UI/API slice, while the repo’s broader authorization infrastructure lives in global/shared enum, user, and Spatie surfaces rather than in Permission-owned module files

## Recommended tranche-4 candidates

- only pursue `Permission` recovery if Lux gains an honest ownership model for global authorization infrastructure that can distinguish shared permission substrate from module-owned admin role-management surfaces
- only pursue `Analytics` recovery if a real consumer path is found, such as route consumers, shared controller/service flows, or owned async/reporting evidence that crosses into another module
- improve second-repo symbol recovery before reusing Atlas as evidence for missing-module follow-up work

## Tranche-4 focus

Tranche 4 re-ran the open question from tranche 3 with a hard artifact requirement:

- does Lux now need an explicit shared/global substrate treatment in boundary interpretation or export surfaces before another export test, especially for authorization/permission infrastructure?

This tranche was not allowed to solve the question by forcing fake ownership, promoting `Global` into a hub, or adding an Auctic-only special case.

## Tranche-4 investigation

What was investigated:

- `src/experts/module-boundary-analysis.ts`
  - reviewed how owned-region, glue, and unresolved nodes currently participate in projection and aggregation
  - confirmed that unresolved shared/global files do not silently become module-owned boundary truth
- `src/cli/overlay.ts`
  - reviewed the current operator/export surface for `overlay boundaries`
  - confirmed that the surface already exports direct vs projected vs supporting evidence without inventing a separate shared-substrate owner
- acme Core authorization and analytics ownership surfaces
  - `src/Module/Permission/RouteServiceProvider.php`
  - `src/Enums/UserPermissionEnum.php`
  - `src/Console/Commands/SetAucticPermissions.php`
  - `src/CoreServiceProvider.php`
  - targeted repo search for `acme\\Core\\Module\\Permission\\...`, `acme\\Core\\Module\\Analytics\\...`, `UserPermissionEnum`, `PermissionRegistrar`, and broad `hasPermissionTo()` / `can()` usage

What the repo evidence showed:

- `Permission` still primarily owns the role-management UI/API slice under `src/Module/Permission/...`
- the broader authorization substrate in acme Core still lives mostly in shared/global surfaces such as:
  - `src/Enums/UserPermissionEnum.php`
  - `src/User.php`
  - shared controllers, middleware, and policies outside `src/Module/Permission`
  - Spatie role/permission models and registrar usage
- targeted namespace search still did not show broad cross-module imports of module-owned `Permission` or `Analytics` implementation surfaces outside module registration/self-use
- a current rerun of `overlay boundaries --json` and `overlay boundaries --direct-only --json` against `/path/to/auctic-core/vcs/.lux/lux.db` returned zero aggregates involving `Permission` or `Analytics`

Assessment:

- this is still not a missing projection bug like tranche 2
- the live question is interpretive: whether Lux should now expose shared/global authorization substrate as its own explicit boundary/export concept

## Tranche-4 changes

- `src/experts/__tests__/module-boundary-analysis.test.ts`
  - added a regression that keeps shared authorization substrate out of `Permission`-owned aggregates even when:
    - `Permission` has a real self-contained admin route/controller slice
    - another module touches the same unresolved shared authorization files
    - a fallback module-dependency signal points toward `Permission`
  - this protects the tranche-4 conclusion from drifting into fake export recovery

Production code change status:

- shared/global substrate treatment changed: **no**
- module-boundary/export logic changed: **no**
- only the regression guard and this validation artifact changed

Why no substrate/export code change was justified:

- Lux already has the honest behavior needed for the next export:
  - owned module boundaries come from owned-region direct or projected evidence
  - shared/global authorization files stay glue or unresolved unless real owned-module paths land
  - the export surface does not currently mis-state shared authorization infrastructure as `Permission` ownership
- adding an explicit shared/global substrate owner now would blur two different truths:
  - `Permission` as a module-owned admin role-management slice
  - authorization as a repo-wide substrate implemented across enum, user, policy, middleware, command, and Spatie surfaces
- under the current ownership model, turning that substrate into a first-class exported module/boundary concept would add ontology weight without producing a more honest module map

## Tranche-4 focused validation

Commands run:

- `npm run build`
- `npm test -- src/experts/__tests__/module-boundary-analysis.test.ts`
- `npm test -- src/cli/__tests__/overlay-boundaries-cli.test.ts`
- `node --import tsx ./src/cli/index.ts --corpus /path/to/auctic-core/vcs overlay boundaries --json`
- `node --import tsx ./src/cli/index.ts --corpus /path/to/auctic-core/vcs overlay boundaries --direct-only --json`

Result:

- build passed
- focused tests passed
- the new regression passed
- acme Core remained `overlay-complete`
- both projected and direct-only boundary exports still showed no aggregates involving `Permission` or `Analytics`

## Tranche-4 conclusion

- what was investigated:
  - current ownership/projection/export behavior in Lux
  - current acme Core authorization and analytics ownership reality
  - current export output on the live acme Core overlay DB
- whether shared/global substrate treatment changed:
  - **no**
- whether code changed or did not change:
  - **no production code change**
  - added a focused regression assertion plus this validation note
- explicit export-test readiness:
  - **yes**

Caveats for interpreting the next export:

- absence of `Permission` from module aggregates is still an honest result under the current ownership model if the underlying authorization logic remains concentrated in shared/global surfaces rather than `src/Module/Permission/...`
- do not read broad `UserPermissionEnum`, `User`, policy, middleware, or Spatie usage as proof that `Permission` owns cross-module authorization traffic
- watch for false positives where export output starts treating shared authorization infrastructure as a `Permission` hub or as a newly owned `Global` domain
- `Analytics` should also still be expected to remain absent unless a real owned-module consumer path lands; route/controller presence plus internal repository binding is not enough
- if a future export wants to mention shared authorization substrate, keep it operator-explanatory only; do not convert it into forced module ownership without persisted owned-path evidence

Requirement traceability:

- `R2` / `R6` / `R7`: preserved by keeping the export evidence-tiered and explainable instead of flattening shared authorization substrate into module truth
- `R4` / `R5`: preserved by refusing hub promotion or fake ownership remap for global/shared authorization files
- `R1` / `R12`: preserved because tranche 4 did not introduce export-only sidecar ontology or non-overlay ownership overrides
- `R10` / `R11`: satisfied by an explicit acme Core rerun centered on the high-salience `Permission` / `Analytics` probe question
- `R14`: satisfied by recording the no-change decision, the rationale, and the caveats explicitly
- `R15`: satisfied by the regression assertion, focused tests, and passing build

Export-readiness recommendation:

- another export test is warranted now
- the correct expectation is not that `Permission` or `Analytics` must appear
- the correct expectation is that the export should remain honest about owned module boundaries while not misclassifying shared/global authorization substrate as module-owned structure
