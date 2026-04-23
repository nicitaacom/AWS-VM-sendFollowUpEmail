"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = exports.decryptTelegramEnvs = void 0;
const vm2_1 = __importDefault(require("vm2"));
const { VM } = vm2_1.default;
const ioredis_1 = __importDefault(require("ioredis"));
const moment_timezone_1 = __importDefault(require("moment-timezone"));
const client_scheduler_1 = require("@aws-sdk/client-scheduler");
const client_ses_1 = require("@aws-sdk/client-ses");
const supabase_js_1 = require("@supabase/supabase-js");
const pusher_1 = __importDefault(require("pusher"));
// should be imported but not passed to VM2 (cuz I don't use it)
const crypto_1 = __importDefault(require("crypto"));
const util_1 = require("util");
// Node related
const buffer_1 = require("buffer");
const url_1 = require("url");
// For freeEmailDomains - so I fetch from entiryRedis envs by correct userId (if sent from gmail cuz user.email domain might be ukr.net)
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
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
            const combined = buffer_1.Buffer.from(encryptedDiscordWebhookUrl, "base64");
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
            const encryptedBytes = buffer_1.Buffer.from(encryptedBase64, "base64");
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
    // 📁 Works because CommonJS has __dirname by default
    const filePath = path_1.default.join(__dirname, "freeEmailList.txt");
    const freeEmailDomains = (0, fs_1.readFileSync)(filePath, "utf-8")
        .split("\n")
        .map(domain => domain.trim().toLowerCase())
        .filter(Boolean); // remove empty lines
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
        PusherServer: pusher_1.default,
        freeEmailDomains
    };
    const vm = new VM({
        timeout: 80000,
        sandbox: {
            process: {
                env: { ...process.env },
            },
            // Node related
            setTimeout,
            Buffer: buffer_1.Buffer,
            URLSearchParams: // required for twilio Authorization token
            url_1.URLSearchParams,
            fetch,
            event,
            imports
        },
    });
    // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
    const transformedCode = responseData.code
        .replace("export const handler = async (event) => {", '')
        .replace("};", ''); // Remove only the last closing `};`
    // 1. extract ALL needed debug helpers
    const debugConstMatch = transformedCode.match(/const DEBUG_DISCORD_WEBHOOK_URL\s*=\s*"([^"]+)"/);
    const truncateMatch = transformedCode.match(/const truncateLongFields\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return JSON\.stringify\(parsed\)\s*\}/);
    const validateMatch = transformedCode.match(/const validateParsedError\s*=\s*\(parsed\)\s*=>\s*[\s\S]*?typeof parsed\.lambdaFnName === "string"/);
    const getErrorInfoMatch = transformedCode.match(/const getErrorInfo\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return \{ lambdaFnName, cause, formattedTime, processedMessage, parsingError \}\s*\}/);
    const sendFnMatch = transformedCode.match(/const sendDiscordDebugMessage\s*=\s*async\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return true\s*\}/);
    const getPartsFnMatch = transformedCode.match(/const getDiscordMessageParts\s*=\s*\(processedMessage,\s*headerLines(?:,\s*note)?\)\s*=>\s*\{[\s\S]*?return messageParts\s*\}/);
    const wrappedCode = `  
      const { Redis, moment, createClient, DeleteScheduleCommand, SchedulerClient, SendRawEmailCommand, SESClient,
             decryptDiscordWebhookUrl, decryptTelegramEnvs, PusherServer, freeEmailDomains } = imports;

      (async () => {
          const response = await (async () => { 
            ${transformedCode} 
          })();
          return response
      })();
    `;
    // clean execution - vm.run returns Promise, do NOT await it
    return vm.run(wrappedCode)
        .then((vm2Resp) => {
        if (!vm2Resp)
            return { statusCode: 500, error: 'VM returned undefined (early return in transformedCode)' };
        return { statusCode: vm2Resp.statusCode || 500, body: vm2Resp };
    })
        .catch(async (error) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (debugConstMatch && truncateMatch && validateMatch && getErrorInfoMatch && sendFnMatch && getPartsFnMatch) {
            const debugCode = `
          ${debugConstMatch[0]};
          ${truncateMatch[0]};
          ${validateMatch[0]};
          ${getErrorInfoMatch[0]};
          ${sendFnMatch[0]};
          ${getPartsFnMatch[0]};
          await sendDiscordDebugMessage(\`VM runtime error in transformedCode: ${errMsg.replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`)
        `;
            try {
                await vm.run(`(async () => { ${debugCode} })()`);
                console.log(383, 'debug message sent to discord');
            }
            catch (debugErr) {
                const debugMessage = debugErr instanceof Error ? debugErr.message : String(debugErr);
                console.log(386, 'debug send failed too:', debugMessage);
            }
        }
        return {
            statusCode: 500,
            error: 'Failed to execute the code for VM-sendFollowUpEmail',
            message: errMsg,
        };
    });
};
exports.handler = handler;
