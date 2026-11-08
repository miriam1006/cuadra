import test from "node:test";
import assert from "node:assert/strict";
import config from "../next.config";

test("the register can request its microphone without enabling other origins, camera or location", async () => {
  const rules = await config.headers!();
  const pageHeaders = rules.find(rule => rule.source === "/:path*")?.headers;
  assert.ok(pageHeaders);
  const policy = pageHeaders.find(header => header.key.toLowerCase() === "permissions-policy")?.value;
  assert.ok(policy);
  const directives = new Map(policy.split(",").map(part => {
    const [name, value] = part.trim().split("=");
    return [name, value];
  }));
  assert.equal(directives.get("microphone"), "(self)");
  assert.equal(directives.get("camera"), "()");
  assert.equal(directives.get("geolocation"), "()");
  assert.equal(pageHeaders.find(header => header.key.toLowerCase() === "x-frame-options")?.value, "DENY");
});
