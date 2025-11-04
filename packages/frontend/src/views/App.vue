<script setup lang="ts">
import Button from "primevue/button";
import { ref } from "vue";

import { useSDK } from "@/plugins/sdk";

// Retrieve the SDK instance to interact with the backend
const sdk = useSDK();

// Flag to only copy when button clicked
const waitingforprojectchange = ref(false);

// Handle project change event from backend
const handleProjectChange = async (projectName: string | undefined) => {

  if (waitingforprojectchange.value == false) {
    return;
  }

  // reset the flag
  waitingforprojectchange.value = false;

  sdk.window.showToast(`Project changed to: ${projectName ?? "unknown"}. Applying scopes, filters, sessions, and match replace rules...`, {
    variant: "info",
  });

  // Get the stored scopes and filters
  const storedDataResult = await sdk.backend.getStoredData();
  if (storedDataResult.kind === "Error") {
    sdk.window.showToast(`Error getting stored data: ${storedDataResult.error}`, {
      variant: "error",
    });
    return;
  }

  const { scopes, filters, sessions, matchReplace, replayCollections } = storedDataResult.value;

  // Get current project
  const projectResult = await sdk.backend.getCurrentProject();
  if (projectResult.kind === "Error") {
    sdk.window.showToast(`Error getting current project: ${projectResult.error}`, {
      variant: "error",
    });
    return;
  }

  const currentProject = projectResult.value;
  if (currentProject === undefined) {
    sdk.window.showToast("No current project found", { variant: "error" });
    return;
  }

  const currentFilters = await sdk.filters.getAll();
  const currentCollections = sdk.matchReplace.getCollections();

  try {
    // Apply scopes to the new project
    if (scopes !== undefined && Array.isArray(scopes)) {
      for (const scope of scopes) {
        await sdk.scopes.createScope(scope);
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
      }
    }

    // Apply match replace collections and rules to the new project
    if (matchReplace !== undefined) {
      const matchReplaceData = matchReplace as { collections: Array<{ id: string; name: string }>; rules: Array<{ id: string; name: string; isEnabled: boolean; query: string; section: unknown; collectionId: string }> };
      
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
              sdk.window.showToast(
                `Error creating match replace collection "${collectionData.name}": Collection was not created`,
                { variant: "warning" }
              );
              continue;
            }
            collectionIdMap.set(collectionData.id, newCollection.id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            sdk.window.showToast(
              `Error creating match replace collection "${collectionData.name}": ${errorMessage}`,
              { variant: "warning" }
            );
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
            sdk.window.showToast(
              `Skipping rule "${ruleName}": Collection not found or not mapped`,
              { variant: "warning" }
            );
            continue;
          }
          
          // Try to create the rule - only skip if there's an error
          // Map all fields from the stored rule to createRule options
          // The new SDK uses 'section' which contains all the match/replace logic
          try {
            await (sdk.matchReplace.createRule as unknown as (options: { collectionId: string; name: string; query?: string; section: unknown }) => Promise<unknown>)({
              collectionId: newCollectionId,
              name: rule.name,
              query: rule.query,
              section: rule.section
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            sdk.window.showToast(
              `Error creating rule "${ruleName}": ${errorMessage}`,
              { variant: "warning" }
            );
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
              sdk.window.showToast(
                `Error creating replay collection "${collectionData.name}": Collection was not created`,
                { variant: "warning" }
              );
              continue;
            }
            collectionIdMap.set(collectionData.id, newCollection.id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            sdk.window.showToast(
              `Error creating replay collection "${collectionData.name}": ${errorMessage}`,
              { variant: "warning" }
            );
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
            sdk.window.showToast(
              `Error creating session "${sessionData.name}": ${createResult.error}`,
              { variant: "error" }
            );
            continue;
          }

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
              const errorMessage =
                error instanceof Error ? error.message : "Unknown error occurred";
              sdk.window.showToast(
                `Session created but could not rename to "${sessionData.name}": ${errorMessage}`,
                { variant: "warning" }
              );
            }
          }
        }
      }
    }

    sdk.window.showToast("Scopes, filters, sessions, and match replace applied successfully", {
      variant: "success",
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    sdk.window.showToast(`Error applying scopes/filters: ${errorMessage}`, {
      variant: "error",
    });
  }
};

// Await project change event
sdk.backend.onEvent("projectChanged", name => handleProjectChange(name));

// Prepare project transfer - get scopes/filters and register listener
const onDuplicateProjectClick = async () => {
  const projectResult = await sdk.backend.getCurrentProject();

  if (projectResult.kind === "Error") {
    sdk.window.showToast(projectResult.error, { variant: "error" });
    return;
  }

  const currentProject = projectResult.value;
  if (currentProject === undefined) {
    sdk.window.showToast("No current project found", { variant: "error" });
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

    if (sessions !== undefined && Array.isArray(sessions)) {
      for (const session of sessions) {
        // Get the request ID from the replay session using GraphQL
        // session.id is a ReplaySession ID, we need the Request ID from the active entry
        const sessionName = session.name ?? String(session.id);
        try {
          const result = await sdk.graphql.activeReplayEntryBySession({ sessionId: session.id });

          // Check if session was found
          if (result.replaySession === undefined || result.replaySession === null) {
            sdk.window.showToast(`Session ${sessionName} not found in GraphQL`, {
              variant: "warning",
            });
            continue;
          }

          const replaySession = result.replaySession;

          // Get request ID from the active entry first
          let requestId: string | undefined = replaySession.activeEntry?.request?.id;
          
          // If no active entry or active entry has no request, search through all entries
          if (requestId === undefined) {
            const entries = replaySession.entries?.nodes;
            if (entries === undefined || entries.length === 0) {
              sdk.window.showToast(`Session ${sessionName} has no entries`, {
                variant: "warning",
              });
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
              sdk.window.showToast(
                `Session ${sessionName} has ${entries.length} entry/entries but none have a request associated. Send the request before duplicating the project.`,
                { variant: "warning" }
              );
              continue;
            }
          }

          // Now get the request data using the request ID
          const sessionResult = await sdk.backend.getSessionByIDWrapper(requestId);
          if (sessionResult.kind === "Error") {
            sdk.window.showToast(
              `Error getting request for session ${sessionName}: ${sessionResult.error}`,
              { variant: "error" }
            );
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
            sdk.window.showToast(`Request data is undefined for session ${sessionName}`, {
              variant: "warning",
            });
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          sdk.window.showToast(
            `Error querying session ${sessionName}: ${errorMessage}`,
            { variant: "error" }
          );
          continue;
        }
      }
    }

    // Prepare match replace data (collections and rules)
    // Store all rules - don't filter them out, let the SDK handle validation
    const allRules = Array.isArray(rules) ? rules : [];
    
    const matchReplaceData = {
      collections: Array.isArray(collections) ? collections.map(c => ({ id: c.id, name: c.name })) : [],
      rules: allRules.map(r => {
        // Store all fields from MatchReplaceRule - map all properties directly
        // The new SDK uses 'section' instead of matchTerm/replaceTerm/strategy
        // Type assertion needed because TypeScript may be using old type definitions
        const rule = r as unknown as { id: string; name: string; isEnabled: boolean; query: string; section: unknown; collectionId: string };
        return {
          id: rule.id,
          name: rule.name,
          isEnabled: rule.isEnabled,
          query: rule.query,
          section: rule.section,
          collectionId: rule.collectionId,
        };
      }),
    };

    // Set the flag to true to await project change event
    waitingforprojectchange.value = true;

    // Prepare replay collections data
    const replayCollectionsData = Array.isArray(replayCollections) 
      ? replayCollections.map(c => ({ id: c.id, name: c.name }))
      : [];

    // Store them in backend and register project change listener
    const prepareResult = await sdk.backend.prepareProjectTransfer(scope, filters, sessionsData, matchReplaceData, undefined, replayCollectionsData);

    if (prepareResult.kind === "Error") {
      sdk.window.showToast(prepareResult.error, { variant: "error" });
      return;
    }

    sdk.window.showToast(
      "Scopes, filters, sessions, and match replace captured. Switch to another project to apply them.",
      { variant: "success" }
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    sdk.window.showToast(`Error preparing project transfer: ${errorMessage}`, {
      variant: "error",
    });
  }
};
</script>

<template>
  <div class="h-full flex justify-start items-start p-4">
    <div class="flex flex-col gap-6 w-full">
      <div class="flex flex-col gap-3">
        <h2 class="text-xl font-semibold">How to Use</h2>
        <div class="text-surface-300 space-y-2">
          <p>1. Click the "Duplicate project" button below from the project you want to copy.</p>
          <p>2. Switch to another project (or create a new one).</p>
          <p>3. The plugin will automatically copy all items to the new project.</p>
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
        </ul>
      </div>
      
      <Button label="Duplicate project" @click="onDuplicateProjectClick" class="w-full" />
    </div>
  </div>
</template>
