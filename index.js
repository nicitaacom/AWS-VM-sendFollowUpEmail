"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = exports.decryptTelegramEnvs = void 0;
const vm2_1 = __importDefault(require("vm2"));
const { VM } = vm2_1.default;
const crypto_1 = __importDefault(require("crypto"));
const ioredis_1 = __importDefault(require("ioredis"));
const moment_timezone_1 = __importDefault(require("moment-timezone"));
const supabase_js_1 = require("@supabase/supabase-js");
const client_scheduler_1 = require("@aws-sdk/client-scheduler");
const client_ses_1 = require("@aws-sdk/client-ses");
const util_1 = require("util");
const NEXT_PUBLIC_PRODUCTION_URL = "https://www.outreach-tool.com/";
const NEXT_PUBLIC_PRODUCTION_AUTH_URL = "https://auth.outreach-tool.com/";
// DO NOT use this function in VM - for some reason it work with smth else but doesn't work with redis
async function decryptDiscordWebhookUrl(encryptedDiscordWebhookUrl) {
    if (typeof window === "undefined") {
        try {
            const encoder = new util_1.TextEncoder();
            const decoder = new util_1.TextDecoder();
            // Define the secret key - mock data
            const secretKey = JSON.stringify({
                provider: ["supabase", "lambda", "discord"],
                APIKey: "replace-with-your-api-key",
            });
            // Convert the Base64-encoded string back to a Uint8Array
            const combined = Buffer.from(encryptedDiscordWebhookUrl, "base64");
            // Extract salt, IV, and ciphertext from the combined array
            const salt = Uint8Array.from(combined.slice(0, 16));
            const iv = combined.slice(16, 28);
            const ciphertext = combined.slice(28);
            // Create key material for PBKDF2
            const keyMaterial = await crypto_1.default.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
                "deriveKey",
            ]);
            // Derive the decryption key using PBKDF2
            const key = await crypto_1.default.subtle.deriveKey({
                name: "PBKDF2",
                salt: salt,
                iterations: 328,
                hash: "SHA-256",
            }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
            // Decrypt the ciphertext
            const decrypted = await crypto_1.default.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
            // Return the decrypted plaintext as a string
            return [decoder.decode(decrypted)];
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during decryption.";
            return `Decryption failed: ${errorMessage}`;
        }
    }
    return "This function must be run on the server.";
}
async function decryptTelegramEnvs(encryptedBase64) {
    if (typeof window === "undefined") {
        try {
            const encoder = new util_1.TextEncoder();
            const decoder = new util_1.TextDecoder();
            const secretKey = JSON.stringify({ provider: ["redis", "lambda", "telegram"] });
            const encryptedBytes = Buffer.from(encryptedBase64, "base64");
            const salt = encryptedBytes.slice(0, 16);
            const iv = encryptedBytes.slice(16, 28);
            const ciphertext = encryptedBytes.slice(28);
            const keyMaterial = await crypto_1.default.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
                "deriveKey",
            ]);
            const key = await crypto_1.default.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 328, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
            const decrypted = await crypto_1.default.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
            const json = decoder.decode(decrypted);
            const data = JSON.parse(json);
            const telegramBotToken = data.telegramBotToken;
            const telegramChatId = data.telegramChatId;
            // === FINAL VALIDATION ===
            if (typeof telegramBotToken !== "string" || telegramBotToken.trim() === "")
                return "Invalid telegramToken";
            if (typeof telegramChatId !== "string" || telegramChatId.trim() === "")
                return "Invalid telegramChatId";
            return { telegramBotToken, telegramChatId };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Decryption failed: ${message}`;
        }
    }
    return "This function must be run on the server.";
}
exports.decryptTelegramEnvs = decryptTelegramEnvs;
// no decrypt twilio because I want want SMS functionality for metrics
const handler = async (event) => {
    if (!NEXT_PUBLIC_PRODUCTION_URL || !NEXT_PUBLIC_PRODUCTION_AUTH_URL) {
        return {
            statusCode: 400,
            error: 'NEXT_PUBLIC_PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_AUTH_URL missing',
        };
    }
    const response = await fetch(`${NEXT_PUBLIC_PRODUCTION_AUTH_URL}api/lambda/VM-sendFollowUpEmail`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": NEXT_PUBLIC_PRODUCTION_URL,
        },
        cache: "no-cache", // Should be no cache to improve security
    });
    if (!response.ok) {
        const errorMessage = await response.text(); // Get the error message from the response body
        throw new Error(`Error ${response.status}: ${errorMessage || "Unknown error"}`);
    }
    const responseData = await response.json();
    const imports = {
        Redis: ioredis_1.default,
        moment: moment_timezone_1.default,
        createClient: supabase_js_1.createClient,
        DeleteScheduleCommand: client_scheduler_1.DeleteScheduleCommand,
        SchedulerClient: client_scheduler_1.SchedulerClient,
        SendRawEmailCommand: client_ses_1.SendRawEmailCommand,
        SESClient: client_ses_1.SESClient,
        decryptDiscordWebhookUrl,
        decryptTelegramEnvs,
        setTimeout,
        crypto: crypto_1.default
    };
    const vm = new VM({
        timeout: 80000,
        sandbox: {
            process: {
                env: { ...process.env },
            },
            fetch,
            event,
            imports
        },
    });
    try {
        // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
        const transformedCode = responseData.code
            // Remove the export handler function line, adjusting to potentially varying spaces
            .replace("export const handler = async (event) => {", '') // Remove handler definition line
            .replace("};", ''); // Remove only the last closing `};`
        const wrappedCode = `  
    const { Redis, moment, createClient, DeleteScheduleCommand, SchedulerClient, SendRawEmailCommand, SESClient,
             decryptDiscordWebhookUrl, decryptTelegramEnvs, setTimeout, crypto } = imports;

    (async () => {
      try {
        const result = await (async () => { 
          ${transformedCode} 
        })();
        return result;
      } catch (error) {
        const messageLines = error.message?.split('\\n').filter(function(line) { return line.trim(); }) || [];
        const stackLines = error.stack?.split('\\n').filter(function(line) { return line.trim(); }) || [];

        var result = {
          statusCode: 500,
          error: 'Failed to execute the code for VM-sendFollowUpEmail',
          message: messageLines[0] || 'Unknown error',
        }

        // 1. additional message lines as message1, message2...
        messageLines.slice(1).forEach(function(line, index) { result['message' + (index + 1)] = line; });

        // 2. stack lines as stack1, stack2...
        stackLines.forEach(function(line, index) { result['stack' + (index + 1)] = line; });

        return result;
      }
    })();
    `;
        // Execute the wrapped code in the VM
        const result = await vm.run(wrappedCode);
        // Handle successful result
        if (result?.statusCode === 200) {
            return {
                statusCode: 200,
                ...result
            };
        }
        // Format error stack if available
        let errorResponse = {
            statusCode: 500,
            error: 'Failed to execute the code for VM-sendFollowUpEmail'
        };
        // Handle error response
        if (result) {
            // Copy all properties from result
            Object.keys(result).forEach((key) => {
                errorResponse[key] = result[key];
            });
        }
        return errorResponse;
    }
    catch (error) {
        console.error('Error executing code in VM:', error);
        // Create base error response
        const errorResponse = {
            statusCode: 500,
            error: 'Failed to execute the code for VM-sendFollowUpEmail'
        };
        // Format error message
        if (error?.message) {
            const messageLines = error.message.split('\n');
            errorResponse.errorSummary = messageLines[0];
            messageLines.slice(1).forEach((line, idx) => {
                if (line.trim()) {
                    errorResponse[`errorInfo${idx + 1}`] = line.trim();
                }
            });
        }
        // Format stack trace
        if (error?.stack) {
            const stackLines = error.stack.split('\n');
            stackLines.forEach((line, idx) => {
                errorResponse[`stackInfo${idx + 1}`] = line.trim();
            });
        }
        return errorResponse;
    }
};
exports.handler = handler;
