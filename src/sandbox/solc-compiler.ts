import solc from 'solc';

export interface CompilationArtifact {
  contractName: string;
  abi: any[];
  bytecode: string;
  sourceCode: string;
}

export interface CompilationResult {
  success: boolean;
  artifacts: Record<string, CompilationArtifact>;
  errors: string[];
}

export class SolcCompiler {
  /**
   * Compiles multiple Solidity source files in memory.
   */
  static compileSources(sources: Record<string, string>): CompilationResult {
    const solcSources: Record<string, { content: string }> = {};
    for (const [fileName, content] of Object.entries(sources)) {
      solcSources[fileName] = { content };
    }

    const input = {
      language: 'Solidity',
      sources: solcSources,
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
        outputSelection: {
          '*': {
            '*': ['abi', 'evm.bytecode.object'],
          },
        },
      },
    };

    try {
      const output = JSON.parse(solc.compile(JSON.stringify(input)));
      const errors: string[] = [];
      const artifacts: Record<string, CompilationArtifact> = {};

      if (output.errors) {
        for (const err of output.errors) {
          if (err.severity === 'error') {
            errors.push(err.formattedMessage || err.message);
          }
        }
      }

      if (errors.length > 0) {
        return { success: false, artifacts: {}, errors };
      }

      if (output.contracts) {
        for (const [fileName, fileContracts] of Object.entries(output.contracts)) {
          for (const [contractName, contractData] of Object.entries(fileContracts as any)) {
            const bytecode = (contractData as any).evm?.bytecode?.object;
            const abi = (contractData as any).abi;

            if (bytecode && bytecode.length > 0) {
              artifacts[contractName] = {
                contractName,
                abi,
                bytecode: `0x${bytecode}`,
                sourceCode: sources[fileName] || '',
              };
            }
          }
        }
      }

      return {
        success: true,
        artifacts,
        errors: [],
      };
    } catch (err: any) {
      return {
        success: false,
        artifacts: {},
        errors: [`Solc compilation exception: ${err.message}`],
      };
    }
  }
}
