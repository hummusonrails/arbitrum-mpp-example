import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['node_modules/**', '.local/**', 'contracts/**'] },
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        rules: {
            curly: ['error', 'all'],
            'padding-line-between-statements': [
                'error',
                {
                    blankLine: 'always',
                    prev: '*',
                    next: ['return', 'if', 'for', 'try', 'function', 'export'],
                },
                {
                    blankLine: 'always',
                    prev: ['block-like', 'function', 'export'],
                    next: '*',
                },
                { blankLine: 'always', prev: ['const', 'let'], next: '*' },
                { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
                { blankLine: 'any', prev: 'export', next: 'export' },
            ],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
);
