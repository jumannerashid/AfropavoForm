// productMatcher.ts
import { LoanIntent } from "./intentExtraction.ts";
import { LoanProduct } from "./loanproducts.ts";

export interface ProductMatch {
  product: LoanProduct;
  score: number;
  eligible: boolean;
  reasons: string[];
}

export class ProductMatcher {
  findMatches(intent: LoanIntent, products: LoanProduct[]): ProductMatch[] {
    const matches = products.map((p) => this.scoreProduct(intent, p));

    return matches.sort((a, b) => {
      if (a.eligible && !b.eligible) return -1;
      if (!a.eligible && b.eligible) return 1;
      return b.score - a.score;
    });
  }

  private scoreProduct(intent: LoanIntent, product: LoanProduct): ProductMatch {
    let score = 0;
    let eligible = true;
    const reasons: string[] = [];

    if (intent.amount >= product.minAmount && intent.amount <= product.maxAmount) {
      score += 30; reasons.push("Amount within range");
    } else { eligible = false; reasons.push("Amount out of range"); }

    if (product.gender === "any" || product.gender === intent.gender) {
      score += 20; reasons.push("Gender OK");
    } else { eligible = false; reasons.push("Gender not OK"); }

    if (intent.age >= product.ageMin && intent.age <= product.ageMax) {
      score += 20; reasons.push("Age OK");
    } else { eligible = false; reasons.push("Age not OK"); }

    if (intent.income >= product.minIncome) {
      score += 15; reasons.push("Income OK");
    } else { eligible = false; reasons.push("Income too low"); }

    if (product.employmentTypes.includes(intent.employment)) {
      score += 10; reasons.push("Employment OK");
    } else { eligible = false; reasons.push("Employment type not accepted"); }

    if (product.purposes.includes(intent.purpose)) {
      score += 5; reasons.push("Purpose matches");
    }

    return { product, score, eligible, reasons };
  }
}
