import { getCurrentFbUserId, requestContext } from "../auth/token-store.js";
import { metaApiClient } from "./client.js";

/** Run a Graph operation with the Page Access Token derived at request time. */
export async function withPageToken<T>(pageId: string, operation: () => Promise<T>): Promise<T> {
  const page = await metaApiClient.get<{ access_token?: string }>(`/${pageId}`, {
    fields: "access_token",
  });
  if (!page.access_token) {
    throw new Error(`No Page Access Token available for page ${pageId}.`);
  }
  return requestContext.run(
    { accessToken: page.access_token, fbUserId: getCurrentFbUserId() },
    operation,
  );
}
