import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import { createClient } from "npm:@supabase/supabase-js";
import "https://deno.land/std@0.224.0/dotenv/load.ts";

import { ProductMatcher } from "./productMatcher.ts";
import { loanProducts } from "./loanproducts.ts";
import { LoanIntent } from "./intentExtraction.ts";

// -------------------
// Supabase setup
// -------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
  throw new Error("All environment variables must be set");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = new Hono();
const productMatcher = new ProductMatcher();

// Helper: Convert DOB → Age
function calculateAge(dob: string): number {
  if (!dob) return 0;
  const birth = new Date(dob);
  const diff = Date.now() - birth.getTime();
  return Math.abs(new Date(diff).getUTCFullYear() - 1970);
}

// -------------------
// Submit form endpoint
// -------------------
app.post("/submit", async (c) => {
  try {
    const formData = await c.req.formData();
    const data: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) data[key] = value;

    // --- Extract Loan Intent ---
    const intent: LoanIntent = {
      amount: Number(data.loanAmount),
      age: calculateAge(String(data.dateOfBirth)),
      gender: String(data.gender),
      income: Number(data.income),
      employment: String(data.employment),
      purpose: String(data.loanPurpose),
    };
console.log("Extracted intent:", intent);
    // -------------------
    // Gemini AI Risk Analysis
    // -------------------
    const geminiPrompt = `
Analyze this loan applicant and return valid JSON:
{
  "riskScore": number (0 = low risk, 100 = high risk),
  "recommendation": "Approved" | "Denied",
  "reasoning": string
}
Applicant data: ${JSON.stringify(intent)}
`;
console.log("Gemini prompt:", geminiPrompt);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
const payload = {
  "contents": [
    {
      "parts": [
        {
          // "role": "user",
          "text": geminiPrompt
        }
      ]
    }
  ]
}
    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
console.log("Gemini raw response:", await geminiResponse.clone().text());
    const geminiJson = await geminiResponse.json();
    console.log("Gemini JSON response:", geminiJson);
    const rawText =
      geminiJson?.candidates?.[0]?.content?.[0]?.text ||
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "{}";
    console.log("Gemini raw text:", rawText);
    const cleanText = rawText.replace(/```json|```/g, "").trim();
    console.log("Gemini cleaned text:", cleanText);
    let geminiData: {
      riskScore: number;
      recommendation: string;
      reasoning?: string;
    } = {
      riskScore: 0,
      recommendation: "Denied",
      reasoning: "No reasoning provided",
    };
    try {
      console.log("Attempting to parse Gemini JSON:", cleanText);
      geminiData = JSON.parse(cleanText);
      console.log("Parsed Gemini data:", geminiData);
    } catch {
      console.error("Gemini JSON parse failed");
    }

    const riskScore = Number(geminiData.riskScore) || 0;
    data["gemini_score"] = riskScore;
    data["gemini_recommendation"] = geminiData.recommendation || "N/A";
    data["gemini_reasoning"] = geminiData.reasoning || "N/A";
    data["gemini_eligible"] =
      geminiData.recommendation === "Approved" ? "Yes" : "No";
    console.log("Gemini response:", geminiData);
    // -------------------
    // Local Product Matching
    // -------------------
    const matches = productMatcher.findMatches(intent, loanProducts);

    // Only products that fully match all criteria including requested amount
    const trulyEligible = matches.filter(
      (m) =>
        m.eligible &&
        intent.amount >= m.product.minAmount &&
        intent.amount <= m.product.maxAmount
    );
    console.log("Product matches:", matches);
    console.log("Truly eligible products:", trulyEligible);
    // Pick the one with the highest score
    const eligibleMatch =
      trulyEligible.length > 0
        ? trulyEligible.reduce((prev, curr) =>
            curr.score > prev.score ? curr : prev
          )
        : null;

    if (eligibleMatch) {
      data["eligible_product"] = "Yes";
      data["eligibility_score"] = eligibleMatch.score;
      data["eligibility_reasons"] = eligibleMatch.reasons.join(", ");
      data["best_product"] = eligibleMatch.product.name;
    } else {
      data["eligible_product"] = "No";
      data["eligibility_score"] = 0;
      // Only show reasons for failed products
      data["eligibility_reasons"] =
        matches
          .filter((m) => !m.eligible)
          .map((m) => `${m.product.name}: ${m.reasons.join(", ")}`)
          .join(" | ") || "No matching products";
      data["best_product"] = "No product found";
    }

    // -------------------
    // Final combined eligibility
    // -------------------
    data["eligible"] =
      data["gemini_eligible"] === "Yes" && data["eligible_product"] === "Yes"
        ? "Yes"
        : "No";

    // -------------------
    // Insert into Supabase
    // -------------------
    const { data: insertedData, error } = await supabase
      .from("Afropavo")
      .insert([data])
      .select()
      .single();

    if (error || !insertedData) {
      console.error(error);
      return c.text(
        "Failed to save data: " + (error?.message || "unknown"),
        500
      );
    }

    return c.redirect(`/submission.html?id=${insertedData.id}`, 303);
  } catch (err) {
    console.error(err);
    return c.text("Unexpected error", 500);
  }
});

// -------------------
// Fetch submission by ID
// -------------------
app.get("/submission/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("Afropavo")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data)
    return c.json({ error: error?.message || "Not found" }, 404);
  return c.json(data);
});

// -------------------
// Serve static files
// -------------------
app.use("/*", serveStatic({ root: "./public" }));

// -------------------
// Start server
// -------------------
Deno.serve({ port: 8000 }, app.fetch);
