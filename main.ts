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

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
  throw new Error(
    "Missing environment variables. Set SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY"
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = new Hono();

// -------------------
// Helper
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
// API Routes
// -------------------

// POST /submit
// POST /submit
app.post("/submit", async (c) => {
  try {
    const formData = await c.req.formData();
    const data: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) data[key] = value;

    const intent = {
      amount: Number(data.loanAmount),
      age: calculateAge(String(data.dateOfBirth)),
      gender: String(data.gender),
      income: Number(data.income),
      employment: String(data.employment),
      purpose: String(data.loanPurpose),
    };

    // -------------------------------
    // Gemini AI Risk Analysis
    // -------------------------------
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

    // Try different possible Gemini response formats
    const rawText =
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ||
      geminiJson?.candidates?.[0]?.content?.[0]?.text ||
      "{}";

    const cleanText = rawText.replace(/```json|```/g, "").trim();

    let geminiData: { riskScore: number; recommendation: string; reasoning?: string };

    try {
      geminiData = JSON.parse(cleanText);
    } catch {
      console.error("Failed to parse Gemini JSON:", cleanText);
      geminiData = {
        riskScore: 50,
        recommendation: "Pending",
        reasoning: "Gemini response unparseable",
      };
    }

    data["gemini_score"] = geminiData.riskScore ?? 0;
    data["gemini_recommendation"] = geminiData.recommendation ?? "Pending";
    data["gemini_reasoning"] = geminiData.reasoning ?? "No reasoning";
    data["gemini_eligible"] = geminiData.recommendation === "Approved" ? "Yes" : "No";

    // -------------------------------
    // Local Product Matching
    // -------------------------------
    const productMatcher = new ProductMatcher();
    const matches = productMatcher.findMatches(intent, loanProducts);

    console.log("=== Product Matching Debug ===");
    console.log("Intent Amount:", intent.amount);
    console.log("All Matches:");
    matches.forEach((m, i) => {
      console.log(
        `#${i + 1} Product: ${m.product.name}, Eligible: ${m.eligible}, Score: ${m.score}, Min: ${m.product.minAmount}, Max: ${m.product.maxAmount}, Reasons: ${m.reasons.join(", ")}`
      );
    });

    const trulyEligible = matches.filter(
      (m) =>
        m.eligible &&
        intent.amount >= Number(m.product.minAmount) &&
        intent.amount <= Number(m.product.maxAmount)
    );

    console.log("Truly Eligible Products:", trulyEligible);

    let eligibleMatch = null;

    if (trulyEligible.length > 0) {
      eligibleMatch = trulyEligible.reduce((prev, curr) =>
        curr.score > prev.score ? curr : prev
      );
      data["eligible_product"] = "Yes";
      data["eligibility_score"] = eligibleMatch.score;
      data["eligibility_reasons"] = eligibleMatch.reasons.join(", ");
      data["best_product"] = eligibleMatch.product.name;
    } else {
      const closestMatch = matches.reduce((prev, curr) =>
        curr.score > prev.score ? curr : prev
      );
      eligibleMatch = closestMatch;
      data["eligible_product"] = "No";
      data["eligibility_score"] = eligibleMatch.score;
      data["eligibility_reasons"] =
        eligibleMatch.reasons.join(", ") + " | Requested amount below minimum";
      data["best_product"] = eligibleMatch.product.name;
    }

    // -------------------------------
    // Final Eligibility (OR condition)
    // -------------------------------
    data["eligible"] =
      data["gemini_eligible"] === "Yes" || data["eligible_product"] === "Yes"
        ? "Yes"
        : "No";

    // -------------------------------
    // Insert into Supabase
    // -------------------------------
    const { data: insertedData, error } = await supabase
      .from("Afropavo")
      .insert([data])
      .select()
      .single();

    if (error || !insertedData) {
      console.error("Supabase insert error:", error);
      return new Response(
        JSON.stringify({ error: error?.message || "Insert failed" }),
        { status: 500 }
      );
    }

    return new Response(JSON.stringify(insertedData), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), {
      status: 500,
    });
  }
});


// GET /loans
app.get("/loans", async (c) => {
  const { data, error } = await supabase
    .from("Afropavo")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Supabase fetch error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  return c.json(data);
});

// GET /loans/:id
app.get("/loans/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("Afropavo")
    .select("*")
    .eq("id", id)
    .single();
  if (error) {
    console.error("Supabase fetch error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  return c.json(data);
});

// PUT /loans/:id
app.put("/loans/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { data, error } = await supabase
    .from("Afropavo")
    .update(body)
    .eq("id", id);
  if (error) {
    console.error("Supabase update error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  return c.json(data);
});

// -------------------
// Dashboard Routing
// -------------------

// Redirect root "/" to /dashboard
app.get("/", (c) => c.redirect("/dashboard"));

// Serve /dashboard explicitly
app.get("/dashboard", async (c) => {
  const path = join("public", "index.html");
  try {
    const body = await Deno.readFile(path);
    return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  } catch {
    return new Response("Dashboard not found", { status: 404 });
  }
});

// Serve all other static files (JS, CSS, images)
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
const server = Deno.serve({ port: 8000 }, (req) => app.fetch(req));
console.log(`Server running at http://localhost:8000`);

