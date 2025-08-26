export interface LoanProduct {
  id: string
  name: string
  maxAmount: number
  minAmount: number
  gender: "male" | "female" | "any"
  ageMin: number
  ageMax: number
  minIncome: number
  purposes: string[]
  employmentTypes: string[]
}

export const loanProducts: LoanProduct[] = [
  {
    id: "personal-basic",
    name: "Personal Loan Basic",
    maxAmount: 50000,
    minAmount: 5000,
    gender: "any",
    ageMin: 18,
    ageMax: 65,
    minIncome: 30000,
    purposes: ["personal", "debt_consolidation", "home_improvement"],
    employmentTypes: ["employed", "self-employed"]
  },
  {
    id: "women-entrepreneur",
    name: "Women Entrepreneur Loan",
    maxAmount: 200000,
    minAmount: 25000,
    gender: "female",
    ageMin: 21,
    ageMax: 60,
    minIncome: 50000,
    purposes: ["business", "equipment"],
    employmentTypes: ["self-employed", "business_owner"]
  },
  {
    id: "student-loan",
    name: "Education Loan",
    maxAmount: 100000,
    minAmount: 10000,
    gender: "any",
    ageMin: 18,
    ageMax: 35,
    minIncome: 0,
    purposes: ["education", "tuition"],
    employmentTypes: ["student", "employed"]
  }
]