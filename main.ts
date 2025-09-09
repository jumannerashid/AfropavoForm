import { Hono } from "https://deno.land/x/hono@v3.1.1/mod.ts";
import { createClient } from "npm:@supabase/supabase-js";
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { join, extname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { loanProducts } from "./loanproducts.ts";
import { ProductMatcher } from "./productMatcher.ts";

// -------------------
// Environment Variables
// -------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const CLOUDINARY_ACCOUNT = Deno.env.get("CLOUDINARY_ACCOUNT");
const CLOUDINARY_UPLOAD_PRESET = Deno.env.get("CLOUDINARY_UPLOAD_PRESET");

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY || !CLOUDINARY_ACCOUNT || !CLOUDINARY_UPLOAD_PRESET) {
  throw new Error(
    "Missing environment variables. Ensure SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, CLOUDINARY_ACCOUNT, CLOUDINARY_UPLOAD_PRESET are set."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = new Hono();

// -------------------
// Helper: Calculate Age
// -------------------
function calculateAge(dob: string): number {
  if (!dob) return 0;
  const birth = new Date(dob);
  const diff = Date.now() - birth.getTime();
  return Math.abs(new Date(diff).getUTCFullYear() - 1970);
}

// -------------------
// CORS Middleware
// -------------------
app.use("*", async (c, next) => {
  const response = await next();
  const safeResponse =
    response instanceof Response
      ? response
      : new Response(String(response) || "", { status: 200 });

  const oldHeaders = safeResponse.headers
    ? Object.fromEntries(safeResponse.headers.entries())
    : {};

  return new Response(safeResponse.body, {
    status: safeResponse.status || 200,
    headers: {
      ...oldHeaders,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
});

app.options("*", () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
});

// -------------------
// POST /submit - Loan submission
// -------------------
app.post("/submit", async (c) => {
  try {
    // Get the form data
    const formData = await c.req.formData();

    // --- Logging for debugging ---
    console.log("Form data received:", Object.fromEntries(formData.entries()));
    const file = formData.get("file") as File | null;
    console.log("File object:", file);

    const data: Record<string, any> = {};
    for (const [key, value] of formData.entries()) data[key] = value;

    // --- File Upload ---
    if (file) {
      try {
        const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_ACCOUNT}/upload`;
        const uploadData = new FormData();
        uploadData.append("file", file);
        uploadData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

        const res = await fetch(cloudinaryUrl, { method: "POST", body: uploadData });
        const result = await res.json();

        if (!res.ok) {
          console.error("Cloudinary upload error:", result);
          return c.json({ error: result.error?.message || "File upload failed" }, 500);
        }

        data.file_url = result.secure_url;
        console.log("File uploaded successfully:", data.file_url);
      } catch (err) {
        console.error("Error during Cloudinary upload:", err);
        return c.json({ error: "Cloudinary upload exception: " + err.message }, 500);
      }
    }

    // --- Gemini AI Risk Analysis ---
    const intent = {
      amount: Number(data.loanAmount),
      age: calculateAge(String(data.dateOfBirth)),
      gender: String(data.gender),
      income: Number(data.income),
      employment: String(data.employment),
      purpose: String(data.loanPurpose),
    };

    try {
      const geminiPrompt = `
Analyze this loan applicant and return valid JSON:
{
  "riskScore": number (0 = low risk, 100 = high risk),
  "recommendation": "Approved" | "Denied",
  "reasoning": string
}
Applicant data: ${JSON.stringify(intent)}
`;

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
      const payload = { contents: [{ parts: [{ text: geminiPrompt }] }] };
      const geminiResp = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const geminiJson = await geminiResp.json();
      const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const cleanText = rawText.replace(/```json|```/g, "").trim();

      let geminiData: { riskScore: number; recommendation: string; reasoning?: string };
      try {
        geminiData = JSON.parse(cleanText);
      } catch {
        geminiData = { riskScore: 50, recommendation: "Pending", reasoning: "Gemini response unparseable" };
      }

      data.gemini_score = geminiData.riskScore ?? 0;
      data.gemini_recommendation = geminiData.recommendation ?? "Pending";
      data.gemini_reasoning = geminiData.reasoning ?? "No reasoning";
      data.gemini_eligible = geminiData.recommendation === "Approved" ? "Yes" : "No";
    } catch (err) {
      console.error("Gemini API error:", err);
      data.gemini_score = 50;
      data.gemini_recommendation = "Pending";
      data.gemini_reasoning = "Gemini API failed";
      data.gemini_eligible = "No";
    }

    // --- Product Matching ---
    try {
      const productMatcher = new ProductMatcher();
      const matches = productMatcher.findMatches(intent, loanProducts);
      const trulyEligible = matches.filter(m => m.eligible && intent.amount >= Number(m.product.minAmount) && intent.amount <= Number(m.product.maxAmount));
      const eligibleMatch = trulyEligible.length > 0
        ? trulyEligible.reduce((prev, curr) => curr.score > prev.score ? curr : prev)
        : matches.reduce((prev, curr) => curr.score > prev.score ? curr : prev);

      data.eligible_product = trulyEligible.length > 0 ? "Yes" : "No";
      data.eligibility_score = eligibleMatch.score;
      data.eligibility_reasons = eligibleMatch.reasons.join(", ") + (trulyEligible.length === 0 ? " | Requested amount below minimum" : "");
      data.best_product = eligibleMatch.product.name;
      data.eligible = data.gemini_eligible === "Yes" || data.eligible_product === "Yes" ? "Yes" : "No";
    } catch (err) {
      console.error("Product matching error:", err);
      data.eligible_product = "No";
      data.eligibility_score = 0;
      data.eligibility_reasons = "Product matching failed";
      data.best_product = "None";
      data.eligible = "No";
    }

    // --- Insert into Supabase ---
    try {
      const { data: insertedData, error } = await supabase.from("Afropavo").insert([data]).select().single();
      if (error || !insertedData) {
        console.error("Supabase insert error:", error);
        return c.json({ error: error?.message || "Insert failed" }, 500);
      }
      console.log("Data inserted successfully:", insertedData);
      return c.json(insertedData);
    } catch (err) {
      console.error("Supabase exception:", err);
      return c.json({ error: "Supabase insert exception: " + err.message }, 500);
    }

  } catch (err) {
    console.error("Unexpected /submit error:", err);
    return c.json({ error: "Unexpected error: " + err.message }, 500);
  }
});

// -------------------
// POST /upload/r2 - File upload
// -------------------
app.post("/upload/r2", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file") as File;
    if (!file) return c.json({ error: "No file uploaded" }, 400);

    const uploadData = new FormData();
    uploadData.append("file", file);
    uploadData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_ACCOUNT}/upload`;

    const res = await fetch(cloudinaryUrl, { method: "POST", body: uploadData });
    const result = await res.json();

    if (!res.ok) return c.json({ error: result.error?.message || "Upload failed" }, 500);

    return c.json({ file_url: result.secure_url });

  } catch (err) {
    console.error("Upload error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// -------------------
// GET all loans
// -------------------
app.get("/loans", async (c) => {
  const { data, error } = await supabase.from("Afropavo").select("*").order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// -------------------
// GET single loan by id
// -------------------
app.get("/loans/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabase.from("Afropavo").select("*").eq("id", id).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// -------------------
// UPDATE loan by id
// -------------------
app.put("/loans/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { data, error } = await supabase.from("Afropavo").update(body).eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// -------------------
// Dashboard & static files
// -------------------
app.get("/", (c) => c.redirect("/dashboard"));
app.get("/dashboard", async (c) => {
  const path = join("public", "index.html");
  try {
    const body = await Deno.readFile(path);
    return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  } catch {
    return new Response("Dashboard not found", { status: 404 });
  }
});

// Serve static files
app.get("/*", async (c) => {
  const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
  const path = join("public", reqPath);

  try {
    const body = await Deno.readFile(path);
    let contentType = "text/plain";
    const ext = extname(path).toLowerCase();
    if (ext === ".html") contentType = "text/html";
    else if (ext === ".js") contentType = "application/javascript";
    else if (ext === ".css") contentType = "text/css";
    else if (ext === ".json") contentType = "application/json";
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".svg") contentType = "image/svg+xml";

    return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
  } catch {
    return new Response("File not found", { status: 404 });
  }
});

// -------------------
// Start server
// -------------------
console.log("Server running at http://localhost:8000");
Deno.serve({ port: 8000 }, (req) => app.fetch(req));
