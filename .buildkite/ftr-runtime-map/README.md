# FTR runtime map (generated)

`runtime_map.json` in this directory is the committed FTR runtime coverage map:
for every enabled FTR config, the `@kbn/` packages its last successful run
actually exercised (server and browser), used for selective FTR execution.

Do not edit it by hand — it is regenerated daily by the scheduled
`kibana-ftr-runtime-map` pipeline and published via a kibanamachine auto-merge
PR. Producer tooling, schema, and design notes live in
`.buildkite/pipeline-utils/ftr-runtime-map/`.

Changes limited to this directory skip CI (`skip_ci_on_only_changed` in
`.buildkite/pull_requests.json`) so the daily refresh PR is ~free.
