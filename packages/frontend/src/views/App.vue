<script setup lang="ts">
import Button from "primevue/button";
import Card from "primevue/card";
import { ref, nextTick } from "vue";

import { useSDK } from "@/plugins/sdk";
import { type Source, type MatchReplaceSection } from "@caido/sdk-frontend/src/types/types/matchReplace";
import { type HTTPQL } from "@caido/sdk-frontend/src/types/types/utils";

// Retrieve the SDK instance to interact with the backend
const sdk = useSDK();

// State for the copy/paste flow
const copyReady = ref(false);
const projectSwitched = ref(false);
const pendingProjectName = ref<string | undefined>(undefined);

// Error log storage
const errorLog = ref<Array<{ message: string; timestamp: Date; variant: string }>>([]);
const errorLogContainer = ref<HTMLElement | undefined>();

// Log a message to the error log panel (no toast)
const logEntry = (message: string, variant: "error" | "warning" | "info" = "info") => {
  errorLog.value.push({ message, timestamp: new Date(), variant });
  nextTick(() => {
    if (errorLogContainer.value) {
      errorLogContainer.value.scrollTop = errorLogContainer.value.scrollHeight;
    }
  });
};

// Clear error log
const clearErrorLog = () => {
  errorLog.value = [];
};

// Apply stored data to the current project
const applyStoredData = async (projectName: string | undefined): Promise<void> => {

  // Get the stored scopes and filters
  const storedDataResult = await sdk.backend.getStoredData();
  if (storedDataResult.kind === "Error") {
    logEntry(`Error getting stored data: ${storedDataResult.error}`, "error");
    sdk.window.showToast("Transfer failed — see error log", { variant: "error" });
    return;
  }

  const { scopes, filters, sessions, matchReplace, replayCollections, environments } = storedDataResult.value;

  // Get current project
  const projectResult = await sdk.backend.getCurrentProject();
  if (projectResult.kind === "Error") {
    logEntry(`Error getting current project: ${projectResult.error}`, "error");
    sdk.window.showToast("Transfer failed — see error log", { variant: "error" });
    return;
  }

  const currentProject = projectResult.value;
  if (currentProject === undefined) {
    logEntry("No current project found", "error");
    sdk.window.showToast("Transfer failed — see error log", { variant: "error" });
    return;
  }

  const currentFilters = await sdk.filters.getAll();
  const currentCollections = sdk.matchReplace.getCollections();

  const counts = { scopes: 0, filters: 0, mrRules: 0, replaySessions: 0, environments: 0 };
  let hadWarnings = false;

  try {
    // Apply scopes to the new project
    if (scopes !== undefined && Array.isArray(scopes)) {
      for (const scope of scopes) {
        await sdk.scopes.createScope(scope);
        counts.scopes += 1;
      }
    }

    // Apply unique filters to the new project
    if (filters !== undefined && Array.isArray(filters)) {
      for (const filter of filters) {
        // If filter.alias matches an alias in currentFilters, skip creating
        if (
          filter.alias !== undefined &&
          Array.isArray(currentFilters) &&
          currentFilters.some(f => f.alias === filter.alias)
        ) {
          continue;
        }
        await sdk.filters.create(filter);
        counts.filters += 1;
      }
    }

    // Apply match replace collections and rules to the new project
    if (matchReplace !== undefined) {
      const matchReplaceData = matchReplace as { collections: Array<{ id: string; name: string }>; rules: Array<{ id: string; name: string; isEnabled: boolean; query: HTTPQL; section: MatchReplaceSection; collectionId: string; sources: Array<Source> }> };

      // Create match replace collections first and map old IDs to new IDs
      const collectionIdMap = new Map<string, string>();

      if (matchReplaceData.collections !== undefined && Array.isArray(matchReplaceData.collections)) {
        for (const collection of matchReplaceData.collections) {
          const collectionData = collection as { id: string; name: string };

          // Check if collection with same name already exists
          let existingCollection: { id: string; name: string } | undefined = undefined;
          if (Array.isArray(currentCollections)) {
            existingCollection = currentCollections.find(c => c.name === collectionData.name);
          }

          if (existingCollection !== undefined) {
            collectionIdMap.set(collectionData.id, existingCollection.id);
            continue;
          }

          // Create new collection using frontend SDK
          try {
            const newCollection = await sdk.matchReplace.createCollection({ name: collectionData.name });
            if (newCollection === undefined || newCollection.id === undefined) {
              logEntry(`Error creating match replace collection "${collectionData.name}": Collection was not created`, "warning");
              hadWarnings = true;
              continue;
            }
            collectionIdMap.set(collectionData.id, newCollection.id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            logEntry(`Error creating match replace collection "${collectionData.name}": ${errorMessage}`, "warning");
            hadWarnings = true;
          }
        }
      }

      // Create rules with mapped collection IDs
      if (matchReplaceData.rules !== undefined && Array.isArray(matchReplaceData.rules)) {
        for (const rule of matchReplaceData.rules) {
          const ruleName = rule.name ?? "Unknown Rule";

          // Get the mapped collection ID
          const newCollectionId = rule.collectionId !== undefined && rule.collectionId !== ""
            ? collectionIdMap.get(rule.collectionId)
            : undefined;

          if (newCollectionId === undefined) {
            logEntry(`Skipping rule "${ruleName}": Collection not found or not mapped`, "warning");
            hadWarnings = true;
            continue;
          }

          // Try to create the rule - only skip if there's an error
          // Map all fields from the stored rule to createRule options
          // The new SDK uses 'section' which contains all the match/replace logic
          // Sources parameter (plural) is now required for match replace rules
          try {
            await sdk.matchReplace.createRule({
              collectionId: newCollectionId,
              name: rule.name,
              query: rule.query,
              section: rule.section,
              sources: []
            });
            counts.mrRules += 1;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logEntry(`Error creating rule "${ruleName}": ${errorMessage}`, "warning");
            hadWarnings = true;
          }
        }
      }
    }

    // Apply replay collections and sessions to the new project
    if (sessions !== undefined) {
      // Create replay collections first and map old IDs to new IDs
      const collectionIdMap = new Map<string, string>();

      if (replayCollections !== undefined && Array.isArray(replayCollections)) {
        const currentReplayCollections = sdk.replay.getCollections();

        for (const collection of replayCollections) {
          const collectionData = collection as { id: string; name: string };

          // Check if collection with same name already exists
          let existingCollection: { id: string; name: string } | undefined = undefined;
          if (Array.isArray(currentReplayCollections)) {
            existingCollection = currentReplayCollections.find(c => c.name === collectionData.name);
          }

          if (existingCollection !== undefined) {
            collectionIdMap.set(collectionData.id, existingCollection.id);
            continue;
          }

          // Create new collection using frontend SDK
          try {
            const newCollection = await sdk.replay.createCollection(collectionData.name);
            if (newCollection === undefined || newCollection.id === undefined) {
              logEntry(`Error creating replay collection "${collectionData.name}": Collection was not created`, "warning");
              hadWarnings = true;
              continue;
            }
            collectionIdMap.set(collectionData.id, newCollection.id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            logEntry(`Error creating replay collection "${collectionData.name}": ${errorMessage}`, "warning");
            hadWarnings = true;
          }
        }
      }

      // Create sessions with mapped collection IDs
      if (Array.isArray(sessions)) {
        for (const session of sessions) {
          const sessionData = session as { rawBytes: number[]; url: string; name: string; collectionId: string };

          // Get the mapped collection ID
          const newCollectionId = sessionData.collectionId !== undefined
            ? collectionIdMap.get(sessionData.collectionId)
            : undefined;

          const createResult = await sdk.backend.createSessionWrapper(
            sessionData.rawBytes,
            sessionData.url,
            newCollectionId
          );

          if (createResult.kind === "Error") {
            logEntry(`Error creating session "${sessionData.name}": ${createResult.error}`, "error");
            hadWarnings = true;
            continue;
          }

          counts.replaySessions += 1;

          // Rename the session if a name was provided and we got a session ID
          if (
            createResult.kind === "Ok" &&
            createResult.value !== undefined &&
            sessionData.name !== undefined
          ) {
            try {
              await sdk.replay.renameSession(createResult.value, sessionData.name);
            } catch (error) {
              // If renaming fails, log but don't fail the whole operation
              const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
              logEntry(`Session created but could not rename to "${sessionData.name}": ${errorMessage}`, "warning");
              hadWarnings = true;
            }
          }
        }
      }
    }

    // Apply environments
    if (environments !== undefined && environments !== null) {
      type StoredEnvVar = { kind: string; name: string; value: string };
      type StoredEnv = { name: string; variables: StoredEnvVar[] };

      const envList = environments as StoredEnv[];
      const existingEnvsResult = await sdk.graphql.environments();

      for (const env of envList) {
        const existing = existingEnvsResult.environments.find(e => e.name === env.name);

        if (existing === undefined) {
          try {
            await sdk.graphql.createEnvironment({
              input: {
                name: env.name,
                variables: env.variables.map(v => ({
                  kind: v.kind as "PLAIN" | "SECRET",
                  name: v.name,
                  value: v.value,
                })),
              },
            });
            counts.environments += 1;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logEntry(`Error creating environment "${env.name}": ${msg}`, "warning");
            hadWarnings = true;
          }
          continue;
        }

        // Merge into existing environment: stored vars override by name, new vars are added
        const existingDetail = await sdk.graphql.environment({ id: existing.id });
        if (existingDetail.environment === undefined || existingDetail.environment === null) {
          logEntry(`Could not fetch existing environment "${env.name}" for update`, "warning");
          hadWarnings = true;
          continue;
        }

        const varMap = new Map(existingDetail.environment.variables.map(v => [v.name, { kind: v.kind, name: v.name, value: v.value }]));
        for (const v of env.variables) {
          varMap.set(v.name, { kind: v.kind as "PLAIN" | "SECRET", name: v.name, value: v.value });
        }

        try {
          await sdk.graphql.updateEnvironment({
            id: existing.id,
            input: {
              name: existing.name,
              variables: Array.from(varMap.values()),
              version: existing.version,
            },
          });
          counts.environments += 1;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logEntry(`Error updating environment "${env.name}": ${msg}`, "warning");
          hadWarnings = true;
        }
      }
    }

    logEntry(`Transfer to "${projectName ?? "unknown"}" complete: ${counts.scopes} scope(s), ${counts.filters} filter(s), ${counts.mrRules} match & replace rule(s), ${counts.replaySessions} replay session(s), ${counts.environments} environment(s)`, "info");

    if (hadWarnings) {
      sdk.window.showToast("Transfer complete with warnings — see error log", { variant: "warning" });
    } else {
      sdk.window.showToast("Transfer complete", { variant: "success" });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    logEntry(`Error applying data: ${errorMessage}`, "error");
    sdk.window.showToast("Transfer failed — see error log", { variant: "error" });
  }
};

// Detect project change — just set flags, paste button triggers the actual apply
sdk.backend.onEvent("projectChanged", name => {
  if (!copyReady.value) return;
  projectSwitched.value = true;
  pendingProjectName.value = name;
});

// Copy Project — capture data from the current project
const onCopyProjectClick = async () => {
  const projectResult = await sdk.backend.getCurrentProject();

  if (projectResult.kind === "Error") {
    logEntry(projectResult.error, "error");
    sdk.window.showToast("Failed to read project — see error log", { variant: "error" });
    return;
  }

  const currentProject = projectResult.value;
  if (currentProject === undefined) {
    logEntry("No current project found", "error");
    sdk.window.showToast("Failed to read project — see error log", { variant: "error" });
    return;
  }

  try {
    // Fetch all data
    const scope = await sdk.scopes.getScopes();
    const filters = await sdk.filters.getAll();
    const sessions = await sdk.replay.getSessions();
    const replayCollections = sdk.replay.getCollections();
    const collections = sdk.matchReplace.getCollections();
    const rules = sdk.matchReplace.getRules();

    const sessionsData: Array<{ rawBytes: number[]; url: string; name: string; collectionId: string }> = [];
    let skippedSessionCount = 0;

    if (sessions !== undefined && Array.isArray(sessions)) {
      for (const session of sessions) {
        // Get the request ID from the replay session using GraphQL
        // session.id is a ReplaySession ID, we need the Request ID from the active entry
        const sessionName = session.name ?? String(session.id);
        try {
          const result = await sdk.graphql.activeReplayEntryBySession({ sessionId: session.id });

          // Check if session was found
          if (result.replaySession === undefined || result.replaySession === null) {
            logEntry(`Session "${sessionName}" not found in GraphQL`, "warning");
            skippedSessionCount += 1;
            continue;
          }

          const replaySession = result.replaySession;

          // Get request ID from the active entry first
          let requestId: string | undefined = replaySession.activeEntry?.request?.id;

          // If no active entry or active entry has no request, search through all entries
          if (requestId === undefined) {
            const entries = replaySession.entries?.nodes;
            if (entries === undefined || entries.length === 0) {
              logEntry(`Session "${sessionName}" has no entries`, "warning");
              skippedSessionCount += 1;
              continue;
            }

            // Find the first entry that has a request associated
            for (const entry of entries) {
              if (entry.request?.id !== undefined) {
                requestId = entry.request.id;
                break;
              }
            }

            // If still no request found after checking all entries
            if (requestId === undefined) {
              logEntry(
                `Session "${sessionName}" has ${entries.length} entry/entries but none have a request associated. Send the request before duplicating the project.`,
                "warning"
              );
              skippedSessionCount += 1;
              continue;
            }
          }

          // Now get the request data using the request ID
          const sessionResult = await sdk.backend.getSessionByIDWrapper(requestId);
          if (sessionResult.kind === "Error") {
            logEntry(`Error getting request for session "${sessionName}": ${sessionResult.error}`, "error");
            skippedSessionCount += 1;
            continue;
          }
          if (sessionResult.value !== undefined) {
            // Backend already extracts raw bytes and URL before serialization
            // Include the session name and collectionId so we can rename it and assign to collection after creation
            sessionsData.push({
              ...sessionResult.value,
              name: sessionName,
              collectionId: session.collectionId
            });
          } else {
            logEntry(`Request data is undefined for session "${sessionName}"`, "warning");
            skippedSessionCount += 1;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
          logEntry(`Error querying session "${sessionName}": ${errorMessage}`, "error");
          skippedSessionCount += 1;
          continue;
        }
      }
    }

    // Prepare match replace data (collections and rules)
    // Store all rules - don't filter them out, let the SDK handle validation
    // Note: MatchReplaceRule type doesn't include sources, but the runtime object might
    const allRules = Array.isArray(rules) ? rules : [];

    const matchReplaceData = {
      collections: Array.isArray(collections) ? collections.map(c => ({ id: c.id, name: c.name })) : [],
      rules: allRules.map(r => {
        // Store all fields from MatchReplaceRule - map all properties directly
        // The new SDK uses 'section' instead of matchTerm/replaceTerm/strategy
        // Sources parameter is now required for match replace rules
        // Type assertion needed because TypeScript may be using old type definitions
        // Check if sources exists on the runtime object even though type doesn't include it
        // MatchReplaceRule type definition doesn't include sources, but it may exist at runtime
        const rule = r as unknown as { id: string; name: string; isEnabled: boolean; query: HTTPQL; section: MatchReplaceSection; collectionId: string; sources?: Array<Source> };
        const ruleAny = r as unknown as Record<string, unknown>;
        // Try to get sources from the rule object, fallback to empty array if not found
        const sources = (Array.isArray(rule.sources) ? rule.sources : Array.isArray(ruleAny.sources) ? ruleAny.sources : []) as Array<Source>;
        return {
          id: rule.id,
          name: rule.name,
          isEnabled: rule.isEnabled,
          query: rule.query,
          section: rule.section,
          collectionId: rule.collectionId,
          sources: sources,
        };
      }),
    };

    // Fetch all environments with their variables
    const envsQueryResult = await sdk.graphql.environments();
    const envs: Array<{ name: string; variables: Array<{ kind: string; name: string; value: string }> }> = [];

    for (const env of envsQueryResult.environments) {
      const detail = await sdk.graphql.environment({ id: env.id });
      if (detail.environment !== undefined && detail.environment !== null) {
        envs.push({
          name: detail.environment.name,
          variables: detail.environment.variables.map(v => ({ kind: v.kind, name: v.name, value: v.value })),
        });
      }
    }

    // Prepare replay collections data
    const replayCollectionsData = Array.isArray(replayCollections)
      ? replayCollections.map(c => ({ id: c.id, name: c.name }))
      : [];

    // Store them in backend and register project change listener
    const prepareResult = await sdk.backend.prepareProjectTransfer(scope, filters, sessionsData, matchReplaceData, replayCollectionsData, envs);

    if (prepareResult.kind === "Error") {
      logEntry(prepareResult.error, "error");
      sdk.window.showToast("Failed to capture data — see error log", { variant: "error" });
      return;
    }

    // Mark copy as done and reset any previous project switch
    copyReady.value = true;
    projectSwitched.value = false;
    pendingProjectName.value = undefined;

    if (skippedSessionCount > 0) {
      sdk.window.showToast(`Data captured (${skippedSessionCount} session(s) skipped — see error log). Switch project then click Paste Project.`, { variant: "warning" });
    } else {
      sdk.window.showToast("Data captured. Switch project then click Paste Project.", { variant: "success" });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    logEntry(`Error preparing project transfer: ${errorMessage}`, "error");
    sdk.window.showToast("Failed to capture data — see error log", { variant: "error" });
  }
};

// Paste Project — apply captured data to the current project
const onPasteProjectClick = async () => {
  if (!copyReady.value) {
    sdk.window.showToast("Please copy a project first", { variant: "error" });
    return;
  }
  if (!projectSwitched.value) {
    sdk.window.showToast("Please change project first", { variant: "error" });
    return;
  }

  // Reset state before applying so a second paste isn't possible without re-copying
  copyReady.value = false;
  projectSwitched.value = false;
  const name = pendingProjectName.value;
  pendingProjectName.value = undefined;

  await applyStoredData(name);
};
</script>

<template>
  <div class="h-full flex justify-start items-start p-4">
    <div class="flex flex-col gap-6 w-full">
      <div class="flex flex-col gap-3">
        <h2 class="text-xl font-semibold">How to Use</h2>
        <div class="text-surface-300 space-y-2">
          <p>1. Click "Copy Project" from the project you want to copy.</p>
          <p>2. Switch to another project (or create a new one).</p>
          <p>3. Click "Paste Project" to apply the copied data to the new project.</p>
        </div>
      </div>
      
      <div class="flex flex-col gap-3">
        <h2 class="text-xl font-semibold">What Gets Copied</h2>
        <ul class="list-disc list-inside text-surface-300 space-y-1 ml-2">
          <li><strong>Scopes</strong> - All scope definitions</li>
          <li><strong>Filters</strong> - All filter definitions</li>
          <li><strong>Replay Sessions</strong> - All replay sessions and their associated collections</li>
          <ul class="list-disc list-inside text-surface-300 space-y-1 ml-6">
            <li><strong style="color: #dc2626;">NOTE</strong> - <span>Replay sessions need to be sent first - sessions with a blank response will not be copied</span></li>
          </ul>
          <li><strong>Match & Replace Rules</strong> - All match & replace rules with their full configurations and associated collections</li>
          <li><strong>Environments</strong> - All environments and their variables (merges into existing environments by name, stored variables take precedence)</li>
        </ul>
      </div>
      
      <div class="flex gap-3">
        <Button label="Copy Project" @click="onCopyProjectClick" class="flex-1" icon="fas fa-copy" severity="secondary" />
        <Button label="Paste Project" @click="onPasteProjectClick" class="flex-1" icon="fas fa-paste" severity="secondary" />
      </div>
      
      <Card v-if="errorLog.length > 0" class="w-full">
        <template #header>
          <div class="flex justify-between items-center p-3">
            <h3 class="text-lg font-semibold">Error Log</h3>
            <Button 
              label="Clear" 
              severity="secondary" 
              size="small"
              @click="clearErrorLog"
              icon="fas fa-trash"
            />
          </div>
        </template>
        <template #content>
          <div 
            ref="errorLogContainer"
            class="overflow-y-auto max-h-96 space-y-2 p-2"
            style="scroll-behavior: smooth;"
          >
            <div
              v-for="(entry, index) in errorLog"
              :key="index"
              class="p-2 rounded border"
              :class="{
                'bg-red-900/20 border-red-700': entry.variant === 'error',
                'bg-yellow-900/20 border-yellow-700': entry.variant === 'warning'
              }"
            >
              <div class="flex justify-between items-start gap-2">
                <span class="text-sm text-surface-300 break-words flex-1">{{ entry.message }}</span>
                <span class="text-xs text-surface-500 whitespace-nowrap">
                  {{ entry.timestamp.toLocaleTimeString() }}
                </span>
              </div>
            </div>
          </div>
        </template>
      </Card>
    </div>
  </div>
</template>