# Cleanup record from the second design pass

Maz approved removing this list on September 5, 2026. Cleanup is complete: all 15 databases, six stopped test containers, and the test image tag are gone; both application copies are in Finder Trash. Read-only checks confirmed the targets were removed and the working app's health endpoint still succeeded.

The source repository, screenshots, design records, `one_door_live_mvp`, running app/worker, and PostgreSQL container and volume were preserved. The names below are a cleanup record, not outstanding deletion instructions.

<details>
<summary>Names and locations recorded after the approved cleanup</summary>

## Test databases

All are in the local `one-door-postgres` container. Dropping them is permanent; they contain only test-provider and fixture activity.

- `one_door_container_pass2`
- `one_door_e2e_pass2_before`
- `one_door_e2e_pass2_final`
- `one_door_e2e_visual_pass2`
- `one_door_pass2_cachecurrency_1`
- `one_door_pass2_catalog_1`
- `one_door_pass2_chain_1`
- `one_door_pass2_deliverylineage_1`
- `one_door_pass2_intake_1`
- `one_door_pass2_model_1`
- `one_door_pass2_readmodel_1`
- `one_door_pass2_requesterfit_1`
- `one_door_pass2_reset_1`
- `one_door_pass2_reviewcorrections_1`
- `one_door_pass2_scope_1`

## Temporary application copies

These copies were moved to `/Users/atighi/.Trash/` under their same final directory names. Their `node_modules` symlinks were not followed, and the working dependency directory remains intact. Useful visual-review PNGs were copied into `design/screenshots/pass-two/claude-review/`; test-session cookie files remain only inside the recoverable trashed copy.

- `/Users/atighi/dev/co_ai-pass2-backend.9OK0Jc`
- `/Users/atighi/dev/co_ai-pass2-visual.GaaWgy`

Their verification servers have been stopped. The main app at port 4180 stays running.

## Stopped test containers and image

The containers are disposable and reconstructable from the repository. They are not the PostgreSQL service.

- `one-door-check-0b3af3e11c-migrate`
- `one-door-check-0b3af3e11c-web`
- `one-door-check-0b3af3e11c-worker`
- `one-door-check-00ad1c82fd-migrate`
- `one-door-check-00ad1c82fd-web`
- `one-door-check-00ad1c82fd-worker`
- Image tag `one-door:pass-two`

Older test artifacts from previous passes are outside this list.

</details>
