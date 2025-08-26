import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"

export interface LoanIntent {
  amount: number
  purpose: string
  age: number
  gender: string
  income: number
  employment: string
  creditScore?: number
}

export class IntentExtractor {
  private genAI: GoogleGenerativeAI
  private model: GenerativeModel  

  constructor() {
    this.genAI = new GoogleGenerativeAI(Deno.env.get("GEMINI_API_KEY")!)
    this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" })
  }

  async extract(text: string): Promise<LoanIntent> {
    const prompt = `
Extract loan information from this text and return ONLY valid JSON:

{
  "amount": number,
  "purpose": "personal|business|education|home_purchase|debt_consolidation|medical|equipment",
  "age": number,
  "gender": "male|female|other",
  "income": number,
  "employment": "employed|self-employed|business_owner|student|retired",
  "creditScore": number or null
}

Text: "${text}"

JSON:
`
    try {
      const result = await this.model.generateContent(prompt)
      const jsonText = result.response.text().trim()

      // Clean up markdown if Gemini adds ```json
      const cleanJson = jsonText
        .replace(/```json\n?/, "")
        .replace(/```$/, "")
        .trim()

      return JSON.parse(cleanJson) as LoanIntent
    } catch (err: unknown) {
      throw new Error(`Failed to extract intent: ${(err as Error).message}`)
    }
  }
}
