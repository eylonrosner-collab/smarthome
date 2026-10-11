import assert from "node:assert/strict";
import test from "node:test";
import { passwordsMatch } from "../src/auth.ts";
import { buildTuyaSign, canonicalPath } from "../src/tuya.ts";

const ACCESS_ID = "testid";
const ACCESS_SECRET = "testsecret";

test("query keys are sorted before signing", () => {
  assert.equal(
    canonicalPath("/v2.0/cloud/thing/device?page_size=20&last_id=abc"),
    "/v2.0/cloud/thing/device?last_id=abc&page_size=20",
  );
  assert.equal(canonicalPath("/v1.0/token?grant_type=1"), "/v1.0/token?grant_type=1");
  assert.equal(canonicalPath("/v1.0/devices/dev/status"), "/v1.0/devices/dev/status");
});

test("token request matches the Python HMAC vector", async () => {
  const signed = await buildTuyaSign({
    accessId: ACCESS_ID,
    accessSecret: ACCESS_SECRET,
    token: "",
    t: "1700000000000",
    method: "GET",
    path: "/v1.0/token?grant_type=1",
  });
  assert.equal(signed.contentHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(signed.stringToSign, "GET\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n/v1.0/token?grant_type=1");
  assert.equal(signed.sign, "18A53EA2AB6725F8B19D5A658B2453789B9DF916B9C4E6BA4D64B6C5A5564653");
});

test("device list sign uses the sorted path even if the caller did not sort it", async () => {
  const sorted = await buildTuyaSign({
    accessId: ACCESS_ID,
    accessSecret: ACCESS_SECRET,
    token: "tok_abc",
    t: "1700000000000",
    method: "GET",
    path: "/v2.0/cloud/thing/device?last_id=abc&page_size=20",
  });
  const unsorted = await buildTuyaSign({
    accessId: ACCESS_ID,
    accessSecret: ACCESS_SECRET,
    token: "tok_abc",
    t: "1700000000000",
    method: "GET",
    path: "/v2.0/cloud/thing/device?page_size=20&last_id=abc",
  });
  assert.equal(sorted.path, unsorted.path);
  assert.equal(sorted.sign, "8807E6F612FF7AA5523AB192B92E8A244D079DBA09991EBA8263486E978F4D0B");
  assert.equal(unsorted.sign, sorted.sign);
});

test("command body matches the Python HMAC vector", async () => {
  const body = '{"commands":[{"code":"switch_1","value":true}]}';
  const signed = await buildTuyaSign({
    accessId: ACCESS_ID,
    accessSecret: ACCESS_SECRET,
    token: "tok_abc",
    t: "1700000001000",
    method: "post",
    path: "/v1.0/devices/dev123/commands",
    body,
  });
  assert.equal(signed.contentHash, "00c2368c059275b6f529e038fc079d641a933173858053bf72070d768d072f0e");
  assert.equal(signed.sign, "F22AA9C56A80A03780F208BB5A847A37EA5DEC85332611F087FEC6FA1AE902B8");
});

test("password compare is exact and rejects an empty server secret", () => {
  assert.equal(passwordsMatch("secret", "secret"), true);
  assert.equal(passwordsMatch("secret", "secre"), false);
  assert.equal(passwordsMatch("secret", "secret2"), false);
  assert.equal(passwordsMatch("", ""), false);
  assert.equal(passwordsMatch("x", ""), false);
});
