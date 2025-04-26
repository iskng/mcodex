/**
 * IPC Server for Codex CLI
 *
 * This module sets up an HTTP and WebSocket server to allow programmatic
 * interaction with the Codex agent core (AgentLoop).
 */
import type { AppConfig } from "./utils/config.js";
// Revert to original deep import path
import type {
  ResponseInputItem,
  ResponseItem,
} from "openai/resources/responses/responses.mjs";

import { type ApprovalPolicy, type ApplyPatchCommand } from "./approvals.js"; // Import ApprovalPolicy and ApplyPatchCommand types
import {
  AgentLoop,
  type CommandConfirmation,
} from "./utils/agent/agent-loop.js"; // Actual import
import { ReviewDecision } from "./utils/agent/review.js"; // For command confirmation
import { createInputItem } from "./utils/input-utils.js"; // To format input
import { randomUUID } from "crypto"; // For generating unique request IDs
import http from "http";
import { type AddressInfo } from "net"; // Import AddressInfo
import { WebSocketServer, WebSocket } from "ws";

// Active AgentLoop instance and config
let agentLoop: AgentLoop | null = null;
// --- Single Client State ---
let connectedClient: WebSocket | null = null;
// Map to store pending command confirmations for the single client
const pendingConfirmations = new Map<
  string,
  {
    resolve: (
      value: CommandConfirmation | PromiseLike<CommandConfirmation>,
    ) => void;
    reject: (reason?: unknown) => void;
    timeoutId: NodeJS.Timeout;
  }
>();
const CONFIRMATION_TIMEOUT_MS = 30000; // 30 seconds timeout for confirmation

// Define a basic interface for incoming messages
interface IncomingMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any; // Keep 'any' for now, refine later as needed
}

// --- WebSocket Handling ---

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  // Enforce single client connection
  if (connectedClient) {
    // console.warn("IPC Server: Rejecting connection attempt, client already connected.");
    ws.close(1013, "Server already has a client connected."); // 1013: Try again later
    return;
  }
  // console.log("IPC Client connected");
  connectedClient = ws;

  ws.on("message", async (message: Buffer | string) => {
    // console.log("Received message from client:", message.toString());
    try {
      const parsedMessage: IncomingMessage = JSON.parse(message.toString());

      if (parsedMessage.type === "user_input") {
        if (!agentLoop) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "AgentLoop not initialized",
            }),
          );
          return;
        }
        // TODO: Validate payload structure more rigorously
        const userInput = parsedMessage.payload as {
          prompt: string;
          images?: Array<string>;
        };

        try {
          // Convert to ResponseInputItem[] and call agentLoop.run()
          const inputItem: ResponseInputItem.Message = await createInputItem(
            userInput.prompt,
            userInput.images ?? [],
          );
          agentLoop.run([inputItem]); // Pass as array per AgentLoop API
          // Send an ack or initial status back
          ws.send(
            JSON.stringify({
              type: "ack",
              message: "Input received and processing started",
            }),
          );
        } catch (inputError) {
          // console.error("Error creating input item:", inputError);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to create input item",
            }),
          );
        }
      } else if (parsedMessage.type === "command_confirmation_response") {
        const { requestId, review, editedCommand } = parsedMessage.payload as {
          requestId: string;
          review: ReviewDecision; // Assuming client sends the ReviewDecision enum value
          editedCommand?: Array<string>;
        };

        const pending = pendingConfirmations.get(requestId);
        if (pending) {
          // console.log(`Server: Received confirmation for ID ${requestId}`, review);
          clearTimeout(pending.timeoutId);
          // Resolve the promise - Note: editedCommand is not part of CommandConfirmation type
          pending.resolve({
            review,
            customDenyMessage: editedCommand?.join(" "),
          });
          pendingConfirmations.delete(requestId); // Clean up
        } else {
          // console.warn(`Server: Received confirmation for unknown/timed-out ID ${requestId}`);
          // Ignore confirmation if request ID is not found or already timed out
        }
      } else {
        ws.send(
          JSON.stringify({ type: "error", message: "Unknown message type" }),
        );
      }
    } catch (error) {
      // console.error("Failed to parse client message or process input:", error);
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid message format" }),
      );
    }
  });

  ws.on("close", () => {
    // console.log("IPC Client disconnected");
    if (ws === connectedClient) {
      connectedClient = null;
    }
  });

  ws.on("error", (_error) => {
    // console.error("WebSocket error:", _error);
    if (ws === connectedClient) {
      connectedClient = null; // Clean up on error
    }
  });

  // Send initial confirmation
  ws.send(
    JSON.stringify({ type: "connected", message: "IPC Server Connected" }),
  );
});

// --- HTTP Server Handling ---

const server = http.createServer((req, res) => {
  // Basic request routing
  if (req.method === "POST" && req.url === "/message") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const message = JSON.parse(body);
        // console.log("Received POST /message:", message);
        // Optionally send POST messages to the connected client
        if (connectedClient && connectedClient.readyState === WebSocket.OPEN) {
          connectedClient.send(
            JSON.stringify({ type: "http_message_received", payload: message }),
          );
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ status: "received", receivedMessage: message }),
        );
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    // Provide more health info, e.g., agent status
    const agentStatus = agentLoop ? "active" : "inactive";
    const isClientConnected = !!connectedClient;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", agentStatus, isClientConnected }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
});

// Upgrade HTTP connections to WebSocket
server.on("upgrade", (request, socket, head) => {
  // Ensure the upgrade request is for our WebSocket path (optional but good practice)
  if (request.url === "/") {
    // Or define a specific path like '/ws'
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    // For other paths, destroy the socket
    socket.destroy();
  }
});

// --- Server Initialization ---

export function startIPCServer(
  config: AppConfig,
  approvalPolicy: ApprovalPolicy, // Added parameter
  additionalWritableRoots: ReadonlyArray<string>, // Added parameter
  // port = 31337, // Remove default fixed port
  requestedPort = 0, // Default to 0 to find an available port
): void {
  // Instantiate and configure AgentLoop here
  agentLoop = new AgentLoop({
    model: config.model,
    config: config,
    instructions: config.instructions,
    approvalPolicy: approvalPolicy, // Use passed policy
    additionalWritableRoots: additionalWritableRoots, // Use passed roots
    disableResponseStorage: config.disableResponseStorage, // Pass this through
    onItem: (item: ResponseItem) => {
      // Send item to the single connected client
      if (connectedClient && connectedClient.readyState === WebSocket.OPEN) {
        connectedClient.send(
          JSON.stringify({ type: "agent_item", payload: item }),
        );
      }
    },
    onLoading: (loading: boolean) => {
      // Send loading status to the single connected client
      if (connectedClient && connectedClient.readyState === WebSocket.OPEN) {
        connectedClient.send(
          JSON.stringify({ type: "agent_status", payload: { loading } }),
        );
      }
    },
    getCommandConfirmation: async (
      _command: Array<string>,
      _applyPatch?: ApplyPatchCommand | undefined, // Use correct imported type
    ): Promise<CommandConfirmation> => {
      const requestId = randomUUID();

      // Send request directly to the single connected client
      if (connectedClient && connectedClient.readyState === WebSocket.OPEN) {
        connectedClient.send(
          JSON.stringify({
            type: "command_confirmation_request",
            payload: {
              requestId,
              command: _command,
              patch: _applyPatch?.patch, // Send patch string if present
            },
          }),
        );
      } else {
        // No client connected, cannot get confirmation
        // console.warn("Server: Cannot request command confirmation, no client connected.");
        return { review: ReviewDecision.NO_CONTINUE }; // Default to safe option
      }

      // Create a promise that will be resolved by the incoming client response
      const confirmationPromise = new Promise<CommandConfirmation>(
        (resolve, reject) => {
          const timeoutId = setTimeout(() => {
            // console.log(`Server: Confirmation timeout for ID ${requestId}`);
            pendingConfirmations.delete(requestId);
            // Default to NO_CONTINUE on timeout for safety
            resolve({ review: ReviewDecision.NO_CONTINUE });
          }, CONFIRMATION_TIMEOUT_MS);

          pendingConfirmations.set(requestId, { resolve, reject, timeoutId });
        },
      );

      try {
        // Wait for the client's response (or timeout)
        const confirmation = await confirmationPromise;
        return confirmation;
      } catch (error) {
        // Should only happen if reject is called unexpectedly
        // console.error(`Server: Error waiting for confirmation ID ${requestId}`, error);
        return { review: ReviewDecision.NO_CONTINUE }; // Default to safe option on error
      } finally {
        // Clean up even if the promise was resolved by timeout before await finished
        const pending = pendingConfirmations.get(requestId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingConfirmations.delete(requestId);
        }
      }
    },
    onLastResponseId: (id: string | null) => {
      // Send last response ID to the single connected client
      if (connectedClient && connectedClient.readyState === WebSocket.OPEN) {
        connectedClient.send(
          JSON.stringify({ type: "agent_last_response_id", payload: { id } }),
        );
      }
    },
  });

  // console.log(`IPC Server starting with config:`, config.model, `Policy: ${approvalPolicy}`);

  // Use requestedPort (defaulting to 0)
  server.listen(requestedPort, () => {
    // Get the actual port the server is listening on
    const address = server.address();
    const actualPort =
      address && typeof address === "object"
        ? (address as AddressInfo).port
        : requestedPort;

    // console.log(`Codex IPC server listening on http://localhost:${actualPort}`);
    // eslint-disable-next-line no-console
    console.log(`ws://localhost:${actualPort}`); // Use actual port and uncomment
  });

  server.on("error", (error) => {
    // console.error("Server error:", error);
    // Handle specific listen errors like EADDRINUSE (might not happen with port 0, but good to keep)
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(
        `Error: Port ${
          requestedPort === 0
            ? "could not be dynamically assigned"
            : requestedPort
        } is already in use or unavailable.`,
      );
      process.exit(1); // Exit if port is taken
    } else {
      // eslint-disable-next-line no-console
      console.error("IPC Server failed to start:", error);
      process.exit(1);
    }
  });
}

// --- Graceful Shutdown ---

function shutdown() {
  // console.log("Shutting down IPC server...");
  // Close the client connection if it exists
  connectedClient?.close();
  wss.close(() => {
    // console.log("WebSocket server closed.");
  });
  server.close(() => {
    // console.log("HTTP server closed.");
    // Add AgentLoop cleanup here if needed
    agentLoop?.terminate(); // Assuming AgentLoop has a terminate method
    process.exit(0);
  });

  // Force close connections after a timeout
  setTimeout(() => {
    // console.error(
    //   "Could not close connections in time, forcefully shutting down",
    // );
    process.exit(1);
  }, 5000); // 5 seconds timeout
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
