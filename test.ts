const testCases = [
  "I'm Sarah, 28 years old, female entrepreneur. Need $150,000 for my business expansion. I'm self-employed making $75,000 annually.",
  "John, 45, employed male with $80k income. Looking for $30k personal loan for home renovation.",
  "Maria, 22, student seeking $50k education loan for medical school tuition."
]

for (const text of testCases) {
  console.log(`\nTesting: ${text}`)
  
  const response = await fetch('http://localhost:8000/loan/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  
  const result = await response.json()
  console.log('Best match:', result.summary.best_match)
  console.log('Intent extracted:', result.intent)
}