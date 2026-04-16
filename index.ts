import VMModule from 'vm2';
const { VM } = VMModule;


import Redis from 'ioredis';
import moment from 'moment-timezone';
import { createClient } from "@supabase/supabase-js"
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { SESClient,  SendRawEmailCommand } from "@aws-sdk/client-ses";

// should be imported but not passed to VM2 (cuz I don't use it)
import crypto from "crypto"
import { TextEncoder, TextDecoder } from "util";

// Node related
import { Buffer } from "buffer"
import { URLSearchParams } from "url"


// For freeEmailDomains - so I fetch from entiryRedis envs by correct userId (if sent from gmail cuz user.email domain might be ukr.net)
import { readFileSync } from "fs"
import path from "path"



export interface IOriginalEmail {
  timestamp: string
  name: string
  from: string
  body: string
}


export interface IOriginalEmail {
  timestamp: string
  name: string
  from: string
  body: string
}


// Define the type for the event
interface Event {
  encryptedRedis:string,
  scheduledEmailsKey:string,
  initialEmailBody:string,
  initialEmailImgUrl?:string,
  initialEmailScheduledAt:string,
  initialEmailName:string, // initial email it's my email
  originalEmail:IOriginalEmail, // optional originalEmail it's someone's email I'm replying to
  idName:string,
  childOfIdName:string,
  emailFrom:string,
  emailTo:string,
  emailSubject:string,
  followUpBody?:string,
  followUpImgUrl?:string,
  isUnsubscribeLink:boolean,
  isLastFollowUp:boolean
}






const NEXT_PUBLIC_PRODUCTION_URL = "https://www.outreach-tool.com/"
const NEXT_PUBLIC_PRODUCTION_AUTH_URL = "https://auth.outreach-tool.com/"














// DO NOT use this function in VM - for some reason it work with smth else but doesn't work with redis
async function decryptDiscordWebhookUrl(encryptedDiscordWebhookUrl: string): Promise<[string] | string> {
  if (typeof window === "undefined") {
    try {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()

      // Define the secret key - mock data
      const secretKey = JSON.stringify({
        provider: ["supabase", "lambda", "discord"],
        APIKey: "replace-with-your-api-key",
      })

      // Convert the Base64-encoded string back to a Uint8Array
      const combined = Buffer.from(encryptedDiscordWebhookUrl, "base64")

      // Extract salt, IV, and ciphertext from the combined array
      const salt = Uint8Array.from(combined.slice(0, 16))
      const iv = combined.slice(16, 28)
      const ciphertext = combined.slice(28)

      // Create key material for PBKDF2
      const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
        "deriveKey",
      ])

      // Derive the decryption key using PBKDF2
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: salt,
          iterations: 328,
          hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      )

      // Decrypt the ciphertext
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)

      // Return the decrypted plaintext as a string
      return [decoder.decode(decrypted)]
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during decryption."
      return `Decryption failed: ${errorMessage}`
    }
  }
  return "This function must be run on the server."
}

















// DO NOT use this function in VM - for some reason it work with smth else but doesn't work with redis

interface TelegramEnvs {
  telegramBotToken: string
  telegramChatId: string
}

export async function decryptTelegramEnvs(encryptedBase64: string): Promise<TelegramEnvs | string> {
  if (typeof window === "undefined") {
    try {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const secretKey = JSON.stringify({ provider: ["redis", "lambda", "telegram"] })

      const encryptedBytes = Buffer.from(encryptedBase64, "base64")

      const salt = encryptedBytes.slice(0, 16)
      const iv = encryptedBytes.slice(16, 28)
      const ciphertext = encryptedBytes.slice(28)

      const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
        "deriveKey",
      ])

      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 328, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      )

      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)

      const json = decoder.decode(decrypted)
      const data = JSON.parse(json)

      const telegramBotToken = data.telegramBotToken
      const telegramChatId = data.telegramChatId

      // === FINAL VALIDATION ===
      if (typeof telegramBotToken !== "string" || telegramBotToken.trim() === "") return "Invalid telegramToken"
      if (typeof telegramChatId !== "string" || telegramChatId.trim() === "") return "Invalid telegramChatId"

      return { telegramBotToken, telegramChatId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Decryption failed: ${message}`
    }
  }
  return "This function must be run on the server."
}
















// no decrypt twilio because I want want SMS functionality for metrics









































export const handler = async (event: Event) => {

  

  if (!NEXT_PUBLIC_PRODUCTION_URL || !NEXT_PUBLIC_PRODUCTION_AUTH_URL) {
    return {
      statusCode: 400,
      error: 'NEXT_PUBLIC_PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_AUTH_URL missing',
    } 
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
  const filePath = path.join(__dirname, "freeEmailList.txt")

  const freeEmailDomains = readFileSync(filePath, "utf-8")
    .split("\n")
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean) // remove empty lines

  

  const imports = {
    Redis,
    moment,
    createClient,
    DeleteScheduleCommand,
    SchedulerClient,
    SendRawEmailCommand,
    SESClient,
    decryptDiscordWebhookUrl,
    decryptTelegramEnvs,
    freeEmailDomains
  }

  const vm = new VM({
    timeout: 80000, // 80 seconds to prevent Lambda timeout (60s for delay and 20s for execution)
    sandbox: {
      process: {
        env: {...process.env},
      },
      // Node related
      setTimeout,
      Buffer, // required for twilio Authorization token
      URLSearchParams,
      fetch, // Pass fetch to the sandbox

      event, // Pass the event to the VM sandbox
      imports
    },
  });


    // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
    const transformedCode = responseData.code
        .replace("export const handler = async (event) => {", '')
        .replace("};", '') // Remove only the last closing `};`

    // 1. extract ALL needed debug helpers
    const debugConstMatch = transformedCode.match(/const DEBUG_DISCORD_WEBHOOK_URL\s*=\s*"([^"]+)"/)
    const truncateMatch = transformedCode.match(/const truncateLongFields\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return JSON\.stringify\(parsed\)\s*\}/)
    const validateMatch = transformedCode.match(/const validateParsedError\s*=\s*\(parsed\)\s*=>\s*[\s\S]*?typeof parsed\.lambdaFnName === "string"/)
    const getErrorInfoMatch = transformedCode.match(/const getErrorInfo\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return \{ lambdaFnName, cause, formattedTime, processedMessage, parsingError \}\s*\}/)
    const sendFnMatch = transformedCode.match(/const sendDiscordDebugMessage\s*=\s*async\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return true\s*\}/)
    const getPartsFnMatch = transformedCode.match(/const getDiscordMessageParts\s*=\s*\(processedMessage,\s*headerLines(?:,\s*note)?\)\s*=>\s*\{[\s\S]*?return messageParts\s*\}/)


    const wrappedCode = `  
      const { Redis, moment, createClient, DeleteScheduleCommand, SchedulerClient, SendRawEmailCommand, SESClient,
             decryptDiscordWebhookUrl, decryptTelegramEnvs, freeEmailDomains } = imports;

      (async () => {
          const response = await (async () => { 
            ${transformedCode} 
          })();
          return response
      })();
    `;

    // clean execution - vm.run returns Promise, do NOT await it
    const vmPromise = vm.run(wrappedCode)

    return vmPromise
      .then((vm2Resp: any) => vm2Resp?.statusCode === 200 
        ? { statusCode: 200, ...vm2Resp }
        : { statusCode: vm2Resp?.statusCode || 500, ...vm2Resp })
      .catch(async (error: unknown) => {
        const errMsg = error instanceof Error ? error.message : String(error)

        // send debug to discord if helpers exist
        if (debugConstMatch && truncateMatch && validateMatch && getErrorInfoMatch && sendFnMatch && getPartsFnMatch) {
          const debugCode = `
            ${debugConstMatch[0]};
            ${truncateMatch[0]};
            ${validateMatch[0]};
            ${getErrorInfoMatch[0]};
            ${sendFnMatch[0]};
            ${getPartsFnMatch[0]};
            await sendDiscordDebugMessage(\`VM runtime error in transformedCode: ${errMsg.replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`)
          `
          try {
            await vm.run(`(async () => { ${debugCode} })()`)
            console.log(383, 'debug message sent to discord')
          } catch (debugErr) {
            const debugMessage = debugErr instanceof Error ? debugErr.message : String(debugErr)
            console.log(386, 'debug send failed too:', debugMessage)
          }
        }

        // return the FULL error response from inside the VM (statusCode 400 + all details)
        // this is the key fix - don't override with generic 500
        return typeof error === 'object' && error !== null && 'statusCode' in error
          ? error
          : {
              statusCode: 500,
              error: 'Failed to execute the code for VM-sendFollowUpEmail',
              message: errMsg,
            }
      })
}