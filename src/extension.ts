import * as vscode from 'vscode';
import * as simpleGit from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

interface ReviewComment {
    filePath: string;
    line: number;
    code: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
    suggestions: Array<{
        description: string;
        code: string;
    }>;
}

const DIAGNOSTIC_SOURCE = '🍐 Pear Review';

class DiagnosticManager {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private storedDiagnostics = new Map<string, vscode.Diagnostic[]>();
    public diagnosticsVisible: boolean = true;
    public hasDiagnostics: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
        context.subscriptions.push(this.diagnosticCollection);
    }

    async processDiagnostics(comments: ReviewComment[]): Promise<void> {
        const reviewsByFile = new Map<string, ReviewComment[]>();

        for (const review of comments) {
            const existing = reviewsByFile.get(review.filePath) || [];
            existing.push(review);
            reviewsByFile.set(review.filePath, existing);
        }

        // Collect all diagnostics in a temp map
        const newDiagnostics = new Map<string, vscode.Diagnostic[]>();

        for (const [filePath, fileReviews] of reviewsByFile.entries()) {
            try {
                const uri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath));
                const document = await vscode.workspace.openTextDocument(uri);
                const diagnostics = this.createDiagnostics(document, fileReviews);
                newDiagnostics.set(uri.toString(), diagnostics);
            } catch (error) {
                console.error(`Failed to process diagnostics for ${filePath}:`, error);
            }
        }

        if (comments.length > 0) {
            this.hasDiagnostics = true;
        }
        
        // Clear old references
        if (this.diagnosticsVisible) {
            this.diagnosticCollection.clear();
            for (const [uriStr, diags] of newDiagnostics) {
                this.diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
            }
        } else {
            this.storedDiagnostics.clear();
            for (const [uriStr, diags] of newDiagnostics) {
                this.storedDiagnostics.set(uriStr, diags);
            }
        }
    }

    private createDiagnostics(document: vscode.TextDocument, reviews: ReviewComment[]): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];

        for (const review of reviews) {
            try {
                const range = this.calculateRange(document, review);
                if (!range) {continue;}

                const diagnostic = new vscode.Diagnostic(
                    range,
                    review.message,
                    this.getSeverity(review.severity)
                );

                diagnostic.source = DIAGNOSTIC_SOURCE;
                diagnostic.code = review.code;

                if (review.suggestions?.length > 0) {
                    diagnostic.relatedInformation = [
                        new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(document.uri, range),
                            'Suggestions available'
                        )
                    ];
                }

                diagnostics.push(diagnostic);
            } catch (error) {
                console.error('Failed to create diagnostic:', error);
            }
        }

        return diagnostics;
    }

    private calculateRange(document: vscode.TextDocument, review: ReviewComment): vscode.Range | null {
        try {
            const lineIndex = Math.max(0, review.line - 1);
            if (lineIndex >= document.lineCount) {return null;}

            const line = document.lineAt(lineIndex);
            const text = line.text;

            // Find the exact position of the code in the line
            const startColumn = text.indexOf(review.code);
            if (startColumn === -1) {
                // If exact match not found, try to find a close match
                const words = review.code.split(/\s+/);
                const firstWord = words[0];
                const approximateStart = text.indexOf(firstWord);

                if (approximateStart !== -1) {
                    return new vscode.Range(
                        lineIndex, approximateStart,
                        lineIndex, approximateStart + review.code.length
                    );
                }

                // If still no match, highlight the entire line
                return new vscode.Range(
                    lineIndex, 0,
                    lineIndex, text.length
                );
            }

            return new vscode.Range(
                lineIndex, startColumn,
                lineIndex, startColumn + review.code.length
            );
        } catch (error) {
            console.error('Failed to calculate range:', error);
            return null;
        }
    }

    private getSeverity(severity: string): vscode.DiagnosticSeverity {
        const severityMap: Record<string, vscode.DiagnosticSeverity> = {
            'error': vscode.DiagnosticSeverity.Error,
            'warning': vscode.DiagnosticSeverity.Warning,
            'info': vscode.DiagnosticSeverity.Information
        };
        return severityMap[severity] ?? vscode.DiagnosticSeverity.Information;
    }

    toggleDiagnosticsVisibility(): void {
        this.diagnosticsVisible = !this.diagnosticsVisible;
        if (!this.diagnosticsVisible) {
            this.storedDiagnostics.clear();
            for (const [uri, diags] of this.diagnosticCollection) {
                this.storedDiagnostics.set(uri.toString(), [...diags]);
            }
            this.diagnosticCollection.clear();
            vscode.window.showInformationMessage('🍐 Review comments are now hidden.');
        } else {
            this.diagnosticCollection.clear();
            for (const [uriStr, diags] of this.storedDiagnostics) {
                this.diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
            }
            this.storedDiagnostics.clear();
            vscode.window.showInformationMessage('🍐 Review comments are now visible.');
        }
    }

    dispose(): void {
        this.diagnosticCollection.dispose();
    }
}

class PrerequisiteChecker {
    private async checkGitAvailability(workspacePath: string): Promise<boolean> {
        try {
            const git = simpleGit.default(workspacePath);
            await git.raw(['--version']);
            return true;
        } catch (error) {
            throw new Error('Git is not available. Please ensure Git is installed and configured.');
        }
    }

    private async checkWorkspace(): Promise<string> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder is open.');
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        const git = simpleGit.default(workspacePath);

        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            throw new Error('This workspace is not a Git repository.');
        }

        return workspacePath;
    }

    private async checkLanguageModel(): Promise<vscode.LanguageModelChat> {
        const [model] = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'gpt-4o'
        });

        if (!model) {
            throw new Error('Language model is not available. Please ensure GitHub Copilot is properly configured.');
        }

        return model;
    }

    async validateAll(): Promise<{ workspacePath: string, model: vscode.LanguageModelChat }> {
        const workspacePath = await this.checkWorkspace();
        await this.checkGitAvailability(workspacePath);
        const model = await this.checkLanguageModel();

        return { workspacePath, model };
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const diagnosticManager = new DiagnosticManager(context);
    const prerequisiteChecker = new PrerequisiteChecker();

    const progressMessages = [
        "Taking a sweet look at your code 🌱",
        "Finding the juiciest improvements 🍐",
        "Carefully tending to your changes 🌿",
        "Helping your code bloom and grow 🌸",
        "Sprinkling some pear-fection ✨",
        "Adding a dash of coding magic 🧙‍♂️",
        "Making everything fresh and crisp 🍃",
        "Nurturing your code with care 💖",
        "Bringing out the best flavors 🍎",
        "Preparing some pear-ticular insights 📝"
    ];

    const reviewChangesDisposable = vscode.commands.registerCommand('pear-review.reviewChanges', async () => {
        try {
            await prerequisiteChecker.validateAll();

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "🍐 Pear Review",
                cancellable: false
            }, async (progress): Promise<void> => {
                let messageIndex = 0;
                const intervalId = setInterval(() => {
                    progress.report({
                        message: progressMessages[messageIndex % progressMessages.length],
                        increment: 5
                    });
                    messageIndex++;
                }, 2500);

                try {
                    const changes = await trackCodeChanges();
                    if (changes.length === 0) {
                        vscode.window.showInformationMessage("🍐 No changes found.");
                        return;
                    }

                    const prompt = buildReviewPrompt(changes);

                    const reviewComments = await generateReviewComments(prompt);

                    const parsedComments = await parseChatResponse(reviewComments);

                    if (parsedComments.length === 0) {
                        vscode.window.showWarningMessage('No review comments were generated. Please try again.');
                    } else {
                        await diagnosticManager.processDiagnostics(parsedComments);
                        vscode.window.showInformationMessage(`🍐 Generated ${parsedComments.length} review comments!`);
                    }

                    if (parsedComments.length > 0 && diagnosticManager.hasDiagnostics) {
                        statusBarToggle.show();
                    }
                } catch (err: unknown) {
                    handlePearError(err, "Review process failed");
                } finally {
                    clearInterval(intervalId);
                }
            });
        } catch (error: unknown) {
            handlePearError(error, "Activation error");
        }
    });

    const toggleDiagnosticsDisposable = vscode.commands.registerCommand('pear-review.toggleDiagnostics', () => {
        if (!diagnosticManager.hasDiagnostics) {
            return;
        }
        diagnosticManager.toggleDiagnosticsVisibility();
        statusBarToggle.text = diagnosticManager.diagnosticsVisible
            ? '$(eye) Hide Review Comments'
            : '$(eye-closed) Show Review Comments';
    });

    context.subscriptions.push(reviewChangesDisposable, toggleDiagnosticsDisposable, diagnosticManager);

    const statusBarToggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarToggle.command = 'pear-review.toggleDiagnostics';
    statusBarToggle.text = '$(eye) Hide Review Comments';
    context.subscriptions.push(statusBarToggle);
}

export function deactivate(): void {}

function handlePearError(error: unknown, contextMessage: string): void {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    vscode.window.showErrorMessage(`🍐 ${contextMessage}: ${errorMsg}`);
}

async function trackCodeChanges(): Promise<any[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return [];
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const git = simpleGit.default(workspacePath);

    try {
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            vscode.window.showErrorMessage('No Git repository found in the workspace.');
            return [];
        }

        const status = await git.status();
        const changes = [];

        for (const file of status.files) {
            const filePath = path.join(workspacePath, file.path);
            const fileUri = vscode.Uri.file(filePath);
            let oldContent = '';
            let newContent = '';
            let diff = '';
            let changeType = '';

            try {
                newContent = fs.readFileSync(filePath, 'utf8');
            } catch (error) {
                vscode.window.showWarningMessage(`Failed to read file: ${filePath}`);
                continue;
            }

            if (file.index === 'A') {
                changeType = 'added';
            } else if (file.index === 'M') {
                changeType = 'modified';
                try {
                    oldContent = await git.show([`HEAD:${file.path}`]);
                } catch (error) {
                    vscode.window.showWarningMessage(`Failed to get previous version of file: ${filePath}`);
                }
            } else if (file.index === 'R') {
                changeType = 'renamed';
            }

            if (changeType === 'modified') {
                diff = await git.diff([`HEAD:${file.path}`, file.path]);
            }

            changes.push({
                uri: fileUri,
                oldContent,
                newContent,
                diff,
                changeType
            });
        }

        return changes;
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to track code changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return [];
    }
}

function buildReviewPrompt(changes: any[]): string {
    const promptText = `
You are the Friendly Neighborhood Pear (🍐), a kind and empathetic code review assistant.
Your personality is warm, supportive, and encouraging. You love helping developers grow and improve their code.

When reviewing code, use these severity levels with empathy:
- error: For critical issues, explained gently but clearly
- warning: For suggestions to help the code grow better
- info: For friendly tips and best practices

Remember to:
- Always start with praise for what's done well
- Be encouraging and supportive while pointing out improvements
- Use friendly, fruit-themed metaphors when appropriate
- Explain WHY changes help, not just WHAT to change
- Keep the tone warm and positive

Check for:
- Code readability: Clear naming and structure (like a well-organized fruit basket!)
- Maintainability: Making sure the code stays fresh and healthy
- Efficiency: Helping the code run as smoothly as ripe fruit
- Security: Keeping the code safe and protected
- Error handling: Preparing for unexpected bumps in the road
- Testing: Making sure everything's as sweet as it should be
- Documentation: Leaving helpful notes for future gardeners
- Style: Keeping everything neat and tidy
- Version control: Maintaining a clear growth history

Use this JSON format for each review item:
{
    "filePath": string,
    "line": number,
    "code": string,
    "message": string,
    "severity": "error" | "warning" | "info",
    "suggestions": [
        {
            "description": string,
            "code": string
        }
    ],
    "praise": string
}

Remember:
Error: Critical issues explained gently but clearly.
Warning: Suggestions for improving the code, phrased kindly.
Info: Helpful tips and best practices, delivered with warmth.

Always be encouraging and supportive!
`;

    let reviewPrompt = promptText + '\n\nFiles to review:\n';

    changes.forEach(change => {
        const relativePath = vscode.workspace.asRelativePath(change.uri);
        reviewPrompt += `\n=== ${relativePath} (${change.changeType}) ===\n`;

        const fileExtension = path.extname(relativePath).replace('.', '') || '';
        reviewPrompt += `File extension: ${fileExtension}\n`;

        const lines = change.newContent.split('\n');
        reviewPrompt += `Total lines: ${lines.length}\n\n`;
        lines.forEach((line: string, index: number) => {
            reviewPrompt += `${index + 1}: ${line}\n`;
        });

        if (change.diff) {
            reviewPrompt += '\nDiff:\n';
            change.diff.split('\n').forEach((line: string) => {
                if (line.startsWith('+')) {
                    reviewPrompt += `Added: ${line.substring(1)}\n`;
                } else if (line.startsWith('-')) {
                    reviewPrompt += `Removed: ${line.substring(1)}\n`;
                }
            });
        }

        reviewPrompt += '\n';
    });

    return reviewPrompt;
}

// Update generateReviewComments to include retry logic
async function generateReviewComments(prompt: string): Promise<vscode.LanguageModelChatResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const [model] = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4o'
            });

            if (!model) {
                throw new Error('No language model available');
            }

            return await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(prompt)],
                {},
                new vscode.CancellationTokenSource().token
            );
        } catch (error) {
            lastError = error instanceof Error ? error : new Error('Unknown error');
            if (attempt === maxRetries) {
                throw lastError;
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }

    throw lastError || new Error('Failed to generate review comments');
}

async function parseChatResponse(chatResponse: vscode.LanguageModelChatResponse): Promise<ReviewComment[]> {
    const output = vscode.window.createOutputChannel("Pear Review Parser");
    let accumulatedResponse = '';
    const parsedComments: ReviewComment[] = [];

    try {
        for await (const fragment of chatResponse.text) {
            accumulatedResponse += fragment;
            output.appendLine(`Received fragment: ${fragment}`);

            if (fragment.includes('}')) {
                try {
                    const matches = accumulatedResponse.match(/\{[^{]*\}/g);
                    if (matches) {
                        for (const match of matches) {
                            try {
                                const reviewComment: ReviewComment = JSON.parse(match);
                                if (reviewComment.filePath && reviewComment.line && 
                                    reviewComment.message && reviewComment.severity) {
                                    parsedComments.push(reviewComment);
                                    output.appendLine(`Successfully parsed comment for ${reviewComment.filePath}`);
                                }
                            } catch (parseError) {
                                output.appendLine(`Failed to parse JSON: ${match}`);
                            }
                        }
                        accumulatedResponse = accumulatedResponse.replace(/\{[^{]*\}/g, '');
                    }
                } catch (e) {
                    output.appendLine(`Error processing fragment: ${e instanceof Error ? e.message : 'Unknown error'}`);
                }
            }
        }

        if (accumulatedResponse.trim()) {
            try {
                const reviewComment: ReviewComment = JSON.parse(accumulatedResponse);
                if (reviewComment.filePath && reviewComment.line && 
                    reviewComment.message && reviewComment.severity) {
                    parsedComments.push(reviewComment);
                }
            } catch (e) {
                output.appendLine(`Failed to parse remaining response: ${accumulatedResponse}`);
            }
        }
    } catch (error) {
        output.appendLine(`Error in parseChatResponse: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
    }

    return parsedComments;
}