jest.mock("../../src/services/hubspotOwnersService", () => ({
  getConnectedOwnerByEmail: jest.fn(),
  getUserIdByEmail: jest.fn(),
}));

import {
  getConnectedOwnerByEmail,
  getUserIdByEmail,
} from "../../src/services/hubspotOwnersService";
import { resolveRequesterScope } from "../../src/middlewares/requesterScope";

const mockedGetOwner = getConnectedOwnerByEmail as jest.Mock;
const mockedGetUserId = getUserIdByEmail as jest.Mock;

const buildReq = (headers: Record<string, string>) => ({ headers }) as any;
const res = {} as any;

const owner = (id: string, email: string) => ({ id, name: id, email });

describe("resolveRequesterScope", () => {
  beforeEach(() => jest.clearAllMocks());

  it("400s when x-requester-email is missing", async () => {
    const next = jest.fn();
    await resolveRequesterScope(buildReq({}), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockedGetUserId).not.toHaveBeenCalled();
  });

  it("403s when the requester email doesn't match any registered user", async () => {
    mockedGetUserId.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    await resolveRequesterScope(
      buildReq({ "x-requester-email": "ghost@example.com" }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("defaults to self-only scope when no scope headers are given", async () => {
    mockedGetUserId.mockResolvedValueOnce("u1");
    const req = buildReq({ "x-requester-email": "rep@example.com" });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.scopeOwnerIds).toEqual(["u1"]);
    expect(req.requesterOwnerId).toBe("u1");
    expect(next).toHaveBeenCalledWith();
  });

  it("x-scope: all unlocks unrestricted access (null)", async () => {
    mockedGetUserId.mockResolvedValueOnce("u1");
    const req = buildReq({ "x-requester-email": "admin@example.com", "x-scope": "all" });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.scopeOwnerIds).toBeNull();
  });

  it("resolves x-scope-emails, always including the requester, dropping unknowns", async () => {
    mockedGetUserId.mockResolvedValueOnce("u1"); // requester
    mockedGetOwner
      .mockResolvedValueOnce(owner("u2", "rep-a@example.com")) // scope email 1
      .mockResolvedValueOnce(undefined); // scope email 2, unknown

    const req = buildReq({
      "x-requester-email": "manager@example.com",
      "x-scope-emails": "rep-a@example.com,ghost@example.com",
    });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.scopeOwnerIds).toEqual(expect.arrayContaining(["u1", "u2"]));
    expect(req.scopeOwnerIds).toHaveLength(2);
  });

  it("authenticates a non-HubSpot-connected but registered user (self-scope only)", async () => {
    mockedGetUserId.mockResolvedValueOnce("u3");
    const req = buildReq({ "x-requester-email": "not-connected@example.com" });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.requesterOwnerId).toBe("u3");
    expect(req.scopeOwnerIds).toEqual(["u3"]);
    expect(next).toHaveBeenCalledWith();
  });
});
