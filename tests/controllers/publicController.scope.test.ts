import { applyRequesterScope, resolveOwnerScope } from "../../src/controllers/publicController";

describe("applyRequesterScope", () => {
  it("returns all owner ids unchanged when scope is null (unrestricted)", () => {
    expect(applyRequesterScope(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("intersects owner ids with an explicit scope list", () => {
    expect(applyRequesterScope(["a", "b", "c"], ["b", "c", "z"])).toEqual(["b", "c"]);
  });

  it("fails closed (empty) when scope is undefined", () => {
    expect(applyRequesterScope(["a", "b"], undefined)).toEqual([]);
  });
});

describe("resolveOwnerScope", () => {
  const ownerIds = ["a", "b", "c"];

  it("scopes the fallback (no filter) case to the requester's allowed owners", () => {
    const req = { query: {}, scopeOwnerIds: ["a"] } as any;
    expect(resolveOwnerScope(req, ownerIds)).toEqual({ userId: undefined, userIds: ["a"] });
  });

  it("still validates ?userId against the scoped set, not the full owner list", () => {
    const req = { query: { userId: "b" }, scopeOwnerIds: ["a"] } as any;
    expect(resolveOwnerScope(req, ownerIds)).toEqual({ userId: undefined, userIds: ["a"] });
  });

  it("allows an unrestricted requester (scopeOwnerIds: null) to pick any owner", () => {
    const req = { query: { userId: "b" }, scopeOwnerIds: null } as any;
    expect(resolveOwnerScope(req, ownerIds)).toEqual({ userId: "b", userIds: undefined });
  });
});
