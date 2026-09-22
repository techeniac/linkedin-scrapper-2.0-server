import axios, { AxiosError } from "axios";
import { hubspotRequest, HUBSPOT_REQUEST_TIMEOUT_MS, MAX_RETRY_DELAY_MS, retryDelayMs } from "./hubspotRequest";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

function rateLimitError(retryAfterSeconds?: number): AxiosError {
  const err: any = new Error("Request failed with status code 429");
  err.isAxiosError = true;
  err.response = {
    status: 429,
    headers: retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {},
  };
  return err;
}

describe("hubspotRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes the shared timeout through to axios on the first attempt", async () => {
    mockedAxios.request.mockResolvedValueOnce({ data: { total: 1 } });

    await hubspotRequest({ method: "post", url: "https://api.hubapi.com/x" });

    expect(mockedAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: HUBSPOT_REQUEST_TIMEOUT_MS }),
    );
  });

  it("retries once after a 429 and returns the eventual success", async () => {
    mockedAxios.request
      .mockRejectedValueOnce(rateLimitError(0))
      .mockResolvedValueOnce({ data: { total: 5 } });

    const result = await hubspotRequest({ method: "post", url: "https://api.hubapi.com/x" });

    expect(result.data).toEqual({ total: 5 });
    expect(mockedAxios.request).toHaveBeenCalledTimes(2);
  });

  it("gives up and throws after exceeding the max retry count on repeated 429s", async () => {
    mockedAxios.request.mockRejectedValue(rateLimitError(0));

    await expect(
      hubspotRequest({ method: "post", url: "https://api.hubapi.com/x" }),
    ).rejects.toMatchObject({ response: { status: 429 } });

    // initial attempt + 3 retries = 4 total calls
    expect(mockedAxios.request).toHaveBeenCalledTimes(4);
  });

  it("caps the wait at MAX_RETRY_DELAY_MS even when HubSpot's Retry-After is much larger", () => {
    const err = rateLimitError(120); // HubSpot asking for a 2-minute wait
    expect(retryDelayMs(err, 1)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("uses exponential backoff, capped, when HubSpot sends no Retry-After header", () => {
    const err = rateLimitError(undefined);
    expect(retryDelayMs(err, 1)).toBe(1000);
    expect(retryDelayMs(err, 2)).toBe(2000);
    expect(retryDelayMs(err, 5)).toBe(MAX_RETRY_DELAY_MS); // 16000ms uncapped -> capped
  });

  it("does not retry a non-429 error", async () => {
    const serverError: any = new Error("Internal Server Error");
    serverError.isAxiosError = true;
    serverError.response = { status: 500, headers: {} };
    mockedAxios.request.mockRejectedValueOnce(serverError);

    await expect(
      hubspotRequest({ method: "post", url: "https://api.hubapi.com/x" }),
    ).rejects.toBe(serverError);
    expect(mockedAxios.request).toHaveBeenCalledTimes(1);
  });
});
