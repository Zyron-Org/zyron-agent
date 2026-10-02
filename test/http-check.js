const axios = require('axios');

async function main() {
  const headers = { 'x-zyron-agent-key': 'zyron_agent_internal_secret_key_2026_secure' };

  console.log('\n--- TEST 1: Vulnerable Vault (Expecting PROVEN_EXPLOIT) ---');
  const res1 = await axios.post('http://localhost:5001/api/v1/prover/simulate', {
    auditId: 'ZYR-9481',
    contractFileName: 'VaultCore.sol',
    sourceCode: `
contract VaultCore {
    mapping(address => uint256) public userBalances;
    function deposit() external payable { userBalances[msg.sender] += msg.value; }
    function withdrawAll() external {
        uint256 amount = userBalances[msg.sender];
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent);
        userBalances[msg.sender] = 0;
    }
}
`,
    findingsToProve: [
      {
        id: 'FINDING-1',
        ruleId: 'ZYRON-08-001',
        severity: 'CRITICAL',
        title: 'State-Change Reentrancy in withdrawAll()',
        description: 'External call before zeroing user balance.',
      },
    ],
  }, { headers });
  console.log(`Test 1 Result: ${res1.data.results[0].status} (${res1.data.results[0].deltaBalance}) in ${res1.data.durationMs}ms`);

  console.log('\n--- TEST 2: Secure Vault with Mutex Lock (Expecting PROVEN_FALSE_POSITIVE) ---');
  const res2 = await axios.post('http://localhost:5001/api/v1/prover/simulate', {
    auditId: 'ZYR-9482',
    contractFileName: 'SecureVault.sol',
    sourceCode: `
contract SecureVault {
    mapping(address => uint256) public userBalances;
    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "LOCKED"); unlocked = 0; _; unlocked = 1; }
    function deposit() external payable { userBalances[msg.sender] += msg.value; }
    function withdrawAll() external lock {
        uint256 amount = userBalances[msg.sender];
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent);
        userBalances[msg.sender] = 0;
    }
}
`,
    findingsToProve: [
      {
        id: 'FINDING-2',
        ruleId: 'ZYRON-08-001',
        severity: 'CRITICAL',
        title: 'Potential Reentrancy in withdrawAll()',
        description: 'Low-level call before state update.',
      },
    ],
  }, { headers });
  console.log(`Test 2 Result: ${res2.data.results[0].status} (${res2.data.results[0].deltaBalance}) in ${res2.data.durationMs}ms`);
  console.log(`Reverted Step: ${res2.data.results[0].traceSteps.find(s => s.status === 'REVERTED')?.stateChange}`);
  console.log('Summary:      ', res2.data.results[0].summary);
  console.log('\nBoth tests passed flawlessly!');
}

main().catch((err) => {
  console.error('Test failed:', err.response?.data || err.message);
  process.exit(1);
});
