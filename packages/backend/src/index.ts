import type { DefineAPI, SDK, DefineEvents } from "caido:plugin";
import type { Project, RequestSpec, ID } from "caido:utils";
import { RequestSpecRaw } from "caido:utils";


export type Result<T> =
  | { kind: "Error"; error: string }
  | { kind: "Ok"; value: T };

// Define backend events that can be sent to frontend
export type BackendEvents = DefineEvents<{
  projectChanged: (projectName: string) => void;
}>;

const getCurrentProject = async (sdk: SDK): Promise<Result<Project | undefined>> => {
  try {
    const currentProject = await sdk.projects.getCurrent();
    return { kind: "Ok", value: currentProject };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    sdk.console.log(`Error getting current project: ${errorMessage}`);
    return { kind: "Error", error: errorMessage };
  }
};

// Store scopes and filters data
let storedScopes: unknown = undefined;
let storedFilters: unknown = undefined;
let storedSessions: unknown = undefined;
let storedMatchReplace: unknown = undefined;
let storedSelectedTypes: unknown = undefined;
let storedReplayCollections: unknown = undefined;

const prepareProjectTransfer = (
  sdk: SDK<API>,
  scopes: unknown,
  filters: unknown,
  sessions: unknown,
  matchReplace: unknown,
  replayCollections: unknown
): Result<void> => {
  try {
    storedScopes = scopes;
    storedFilters = filters;
    storedSessions = sessions;
    storedMatchReplace = matchReplace;
    storedReplayCollections = replayCollections;
    return { kind: "Ok", value: undefined };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    sdk.console.log(`Error preparing project transfer: ${errorMessage}`);
    return { kind: "Error", error: errorMessage };
  }
};

const getStoredData = (sdk: SDK): Result<{ scopes: unknown; filters: unknown; sessions: unknown; matchReplace: unknown; selectedTypes: unknown; replayCollections: unknown }> => {
  try {
    return { kind: "Ok", value: { scopes: storedScopes, filters: storedFilters, sessions: storedSessions, matchReplace: storedMatchReplace, selectedTypes: storedSelectedTypes, replayCollections: storedReplayCollections } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    sdk.console.log(`Error getting stored data: ${errorMessage}`);
    return { kind: "Error", error: errorMessage };
  }
};

const createSessionWrapper = async (
  sdk: SDK,
  rawBytesArray: number[],
  url: string,
  collectionId?: ID
): Promise<Result<ID | undefined>> => {
  try {
    // Convert array of numbers back to Uint8Array
    // Uint8Array doesn't serialize over RPC, so we pass as number array
    const rawBytes = new Uint8Array(rawBytesArray);
    
    // Reconstruct RequestSpecRaw from raw bytes and URL
    // RequestSpecRaw methods don't serialize over RPC, so we pass raw bytes and URL separately
    const requestSpecRaw = new RequestSpecRaw(url);
    requestSpecRaw.setRaw(rawBytes);
    
    // Convert to RequestSpec which is a valid RequestSource
    const requestSpec: RequestSpec = requestSpecRaw.getSpec();
    
    // Create session with optional collection ID
    const session = await sdk.replay.createSession(requestSpec, collectionId);
    const sessionId = session.getId();
    
    // Return the session ID so the frontend can rename it
    return { kind: "Ok", value: sessionId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    sdk.console.log(`Error creating session: ${errorMessage}`);
    return { kind: "Error", error: errorMessage };
  }
};

const getSessionByIDWrapper = async (
  sdk: SDK,
  requestId: ID
): Promise<Result<{ rawBytes: number[]; url: string } | undefined>> => {
  try {
    // requestId is the actual Request ID (obtained from frontend via GraphQL)
    // Get the actual request using the request ID
    const requestResponse = await sdk.requests.get(requestId);
    if (requestResponse === undefined || requestResponse.request === undefined) {
      return { kind: "Ok", value: undefined };
    }

    // Extract raw bytes and URL before serialization
    // RequestSpecRaw methods don't serialize over RPC
    // Uint8Array doesn't serialize, so convert to number array
    const requestSpecRaw = requestResponse.request.toSpecRaw();
    const rawBytesUint8 = requestSpecRaw.getRaw();
    const rawBytes = Array.from(rawBytesUint8); // Convert Uint8Array to number[]
    const host = requestSpecRaw.getHost();
    const port = requestSpecRaw.getPort();
    const tls = requestSpecRaw.getTls();
    const url = `${tls ? "https" : "http"}://${host}${port ? `:${port}` : ""}`;

    return { kind: "Ok", value: { rawBytes, url } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    sdk.console.log(`Error getting session: ${errorMessage}`);
    return { kind: "Error", error: errorMessage };
  }
};

export type API = DefineAPI<{
  getCurrentProject: typeof getCurrentProject;
  prepareProjectTransfer: typeof prepareProjectTransfer;
  getStoredData: typeof getStoredData;
  createSessionWrapper: typeof createSessionWrapper;
  getSessionByIDWrapper: typeof getSessionByIDWrapper;
}>;

export function init(sdk: SDK<API, BackendEvents>) {
  sdk.api.register("getCurrentProject", getCurrentProject);
  sdk.api.register("prepareProjectTransfer", prepareProjectTransfer);
  sdk.api.register("getStoredData", getStoredData);
  sdk.api.register("createSessionWrapper", createSessionWrapper);
  sdk.api.register("getSessionByIDWrapper", getSessionByIDWrapper);

  sdk.events.onProjectChange(async (sdk, project) => {
    const name = project?.getName();
    if (project === null) {
      sdk.api.send("projectChanged", name);
      return;
    }

    sdk.api.send("projectChanged", name);
  });
}
