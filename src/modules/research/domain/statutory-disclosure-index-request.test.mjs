import assert from "node:assert/strict";
import test from "node:test";
import { statutoryDisclosureIndexRefreshOptions } from "../api/research.routes.ts";

test("historical statutory index refresh is explicitly bounded and does not imply a review action", () => {
  assert.deepEqual(
    statutoryDisclosureIndexRefreshOptions({ page: "3", pageSize: "30" }),
    { page: 3, pageSize: 30 },
  );
  assert.deepEqual(
    statutoryDisclosureIndexRefreshOptions({}),
    { page: 1, pageSize: 30 },
  );
  for (const input of [{ page: "0" }, { page: "101" }, { page: "3.1" }, { page: "three" }, { pageSize: "31" }]) {
    assert.throws(() => statutoryDisclosureIndexRefreshOptions(input), /must be an integer/);
  }
});
