import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import { createClient } from "npm:@supabase/supabase-js";
import "https://deno.land/std@0.224.0/dotenv/load.ts";


// Env variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in environment variables");
}

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = new Hono();

// Ignore favicon requests
app.get("/favicon.ico", (c) => c.text("", 204));

// Serve static files
app.use("/*", serveStatic({ root: "./public" }));

// Handle form submission
app.post("/submit", async (c) => {
  const data = await c.req.json();
  const requiredFields = [
    "fullName","email","dateOfBirth","age","phone",
    "loanAmount","loanTerm","employment","income","loanPurpose"
  ];
  for (const key of requiredFields) {
    if (!data[key] || String(data[key]).trim() === "") {
      return c.text(`Missing field: ${key}`, 400);
    }
  }

  const { error } = await supabase.from("Afropavo").insert([data]);
  if (error) return c.text("Failed to save data: " + error.message, 500);

  return c.json({ ok: true });
});

// Start server
Deno.serve({ port: 8000 }, app.fetch);
