# n8n Data Table node + HTTP Request options (verified 2026-09-23)

Pinned to **n8n@2.33.0** (commit `60cc920c40d6090816b8f7418f10ac645814fe9f`); the instance
runs 2.33.x. Commit messages 2.33.1–2.33.7 mention no data-table, HTTP-Request or
resource-mapper change, but the 2.33.7 file diff was not inspected (low risk).
Paths: `DT/` = `packages/nodes-base/nodes/DataTable/`, `CLI/` =
`packages/cli/src/modules/data-table/`; raw URL pattern
`https://raw.githubusercontent.com/n8n-io/n8n/n8n@2.33.0/<path>`.
Used by `deploy/n8n/youtube-summaries-nightly.json`.

## Data Table node

1. **Type** `n8n-nodes-base.dataTable`, versions `[1, 1.1]`; 1.1 returns dates as ISO
   strings in `get` output. — `DT/DataTable.node.ts`, `DT/common/selectMany.ts`
2. **Row operations**: `get`, `insert`, `update`, `upsert`, `deleteRows`, `rowExists`,
   `rowNotExists` (`resource: "row"`). — `DT/actions/row/Row.resource.ts`
3. **Table reference**: resource locator `dataTableId`, modes `list | name | id`, JSON
   `{"__rl": true, "mode": "id", "value": "<id>"}`. — `DT/common/fields.ts`, `DT/common/utils.ts`
4. **Filters**: `matchType` = `anyCondition` (**default, OR**) | `allConditions`;
   `filters.conditions[] = {keyName, condition, keyValue}`. — `DT/common/selectMany.ts`
5. **Conditions** `eq, neq, like, ilike, gt, gte, lt, lte, isEmpty, isNotEmpty, isTrue,
   isFalse`. `isEmpty` is `IS NULL` (does **not** match `''`); `neq X` is
   `(col != X OR col IS NULL)`, so rows with an unset column pass. — `DT/common/utils.ts`
   `buildGetManyFilter`, `CLI/data-table-rows.repository.ts` `getConditionAndParams`
6. **get** without `returnAll` returns at most `limit` (default 50) per input item;
   `returnAll: true` pages internally. — `DT/actions/row/get.operation.ts`, `DT/common/constants.ts`
7. **Partial update**: `update`/`upsert` write only the keys present in
   `columns.value` (`mappingMode: "defineBelow"`) plus `updatedAt`; unmapped columns stay
   untouched. A mapped key whose value is null/undefined is written as **NULL** — to
   leave a column alone, do not map it. `autoMapInputData` writes every key of the item
   and fails on unknown keys. Update matching several rows updates all of them; no match
   changes nothing and returns no items. — `DT/common/addRow.ts`,
   `CLI/data-table.service.ts` (`upsertRow`, `validateAndTransformUpdateParams`),
   `CLI/data-table-rows.repository.ts`
8. **Upsert** inserts `data` when nothing matches, so unmapped columns are NULL on a new
   row. — `CLI/data-table.service.ts` `upsertRow`
9. **Columns cannot be created by row operations**: unknown keys fail with
   `unknown column name '<key>'`; filtering on a missing column fails with
   `Filter validation failed: Column(s) "X" do not exist`. Add columns in the UI or via
   the public API `POST /data-tables/{id}/columns`. — `CLI/data-table.service.ts`,
   `DT/common/selectMany.ts` `getSelectFilter`, `packages/cli/src/public-api/v1/openapi.yml`
10. **Limits**: only total size across all tables, `N8N_DATA_TABLES_MAX_SIZE_BYTES`
    (default 200 MiB); no row limit. — `packages/@n8n/config/src/configs/data-table.config.ts`
11. **Editor caveat**: building/editing the mapping in the UI pre-fills all columns
    (`addAllFields`) and keeps boolean fields as `false`; check the saved
    `columns.value` after editing. — `packages/frontend/editor-ui/src/features/ndv/parameters/components/ResourceMapper/ResourceMapper.vue`

## HTTP Request node

12. Versions 4–4.5 share the V3 implementation; options
    `options.response.response.fullResponse`, `options.response.response.neverError`,
    `options.timeout` (ms). — `packages/nodes-base/nodes/HttpRequest/HttpRequest.node.ts`,
    `packages/nodes-base/nodes/HttpRequest/V3/Description.ts`

## Not verified live

- Empty string vs NULL behaviour on the instance's database (read from code only). The
  workflow therefore treats `null` and `''` alike in JavaScript and never relies on
  `isEmpty`.
- Whether the sort job's existing upsert maps the summary columns: operator gate, see
  `docs/decisions.md` 2026-09-23.

Docs: https://docs.n8n.io/build/work-with-data/data-tables ·
https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datatable/
