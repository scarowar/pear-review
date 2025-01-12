import * as vscode from 'vscode';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';

// ═══════════════════════════════════════════════════════════════════════════
// Types & Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Represents different types of targets that can be reviewed */
type ReviewTarget = vscode.TextDocument[] | readonly vscode.SourceControlResourceState[] | FileChange[];

/** Represents a change in a file detected by Git */
interface FileChange {
    uri: vscode.Uri;
    oldContent: string | null;
    newContent: string;
    diff: string;
    type: 'add' | 'modify' | 'delete';
}

/** Represents a code review comment */
interface ReviewComment {
    filePath: string;
    line: number;
    startColumn?: number;
    endColumn?: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
    range: vscode.Range;
    code: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Services
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handles Git operations and file changes
 */
export class GitService {
    private git: SimpleGit | null = null;
    private workspacePath: string | null = null;

    async initialize(): Promise<boolean> {
        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                return false;
            }

            this.workspacePath = workspacePath;
            this.git = simpleGit(this.workspacePath);
            return true;
        } catch (error) {
            return false;
        }
    }

    async getChangedFiles(): Promise<FileChange[]> {
        if (!this.git || !this.workspacePath) {
            throw new Error('Git not initialized');
        }

        const changes: FileChange[] = [];

        try {
            const status = await this.git.status();

            // Get all changed files (modified, new, renamed)
            const allChanges = [
                ...status.modified,
                ...status.not_added,
                ...status.created,
                ...status.renamed.map(r => r.to)
            ];

            // Remove duplicates
            const uniqueFiles = [...new Set(allChanges)];

            for (const file of uniqueFiles) {
                try {
                    const fullPath = path.join(this.workspacePath, file);
                    const uri = vscode.Uri.file(fullPath);
                    
                    // Try to get current content
                    let newContent = '';
                    try {
                        newContent = await this.readFile(fullPath);
                    } catch (error) {
                        continue; // Skip files we can't read
                    }

                    // Determine file type and get old content if applicable
                    let type: 'add' | 'modify';
                    let oldContent: string | null = null;
                    let diff = '';

                    if (status.modified.includes(file) || status.renamed.some(r => r.to === file)) {
                        type = 'modify';
                        try {
                            oldContent = await this.git.show([`HEAD:${file}`]);
                            diff = await this.git.diff(['HEAD', '--', file]);
                        } catch (error) {
                            oldContent = '';
                            diff = newContent;
                        }
                    } else {
                        type = 'add';
                        diff = newContent;
                    }

                    changes.push({ uri, oldContent, newContent, diff, type });
                } catch (error) {
                }
            }

            return changes;
        } catch (error) {
            throw new Error('Failed to get git changes');
        }
    }

    private async readFile(filePath: string): Promise<string> {
        try {
            const uri = vscode.Uri.file(filePath);
            const data = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(data);
        } catch (error) {
            return '';
        }
    }
}


/**
 * Manages code review functionality and diagnostics
 */
export class ReviewService {
    private previousReviews = new Map<string, ReviewComment[]>();
    private diagnosticCollection: vscode.DiagnosticCollection;
    private cachedDiagnostics = new Map<string, vscode.Diagnostic[]>();
    private isVisible = true;

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    }

    async reviewFiles(files: { uri: vscode.Uri, content: string }[]): Promise<void> {
        const model = await this.getCopilotModel();
        if (!model) {
            throw new Error("🍐 I couldn't connect to GitHub Copilot");
        }

        const allReviews: ReviewComment[] = [];

        for (const file of files) {
            const filePath = vscode.workspace.asRelativePath(file.uri);
            const contentWithContext = this.prepareCodeWithContext(file.content, file.uri);

            // Create the prompt for the individual file
            const prompt = `${REVIEW_PROMPT}\n\nFile to review:\n--- ${filePath} ---\n${contentWithContext}`;

            const messages = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            const chatResponse = await model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            const reviews = await this.parseReviewResponse(chatResponse);
            allReviews.push(...reviews);
        }

        await this.processDiagnostics(allReviews);

        // Only show diagnostics if they were visible before
        if (!this.isVisible) {
            this.hideAllDiagnostics();
        }

        // Store reviews for change detection
        for (const review of allReviews) {
            const existingReviews = this.previousReviews.get(review.filePath) || [];
            this.previousReviews.set(review.filePath, [...existingReviews, review]);
        }

        // Provide positive feedback if no issues were found
        if (allReviews.length === 0) {
            vscode.window.showInformationMessage(this.getRandomPraiseMessage());
        }
    }

    private prepareCodeWithContext(content: string, uri: vscode.Uri): string {
        const lines = content.split('\n');
        const fileExtension = path.extname(uri.fsPath).replace('.', '') || '';

        let numberedCode = `File extension: ${fileExtension}\nTotal lines: ${lines.length}\n\n`;
        lines.forEach((line, index) => {
            numberedCode += `${index + 1}: ${line}\n`;
        });

        return numberedCode;
    }

    private async parseReviewResponse(
        response: vscode.LanguageModelChatResponse
    ): Promise<ReviewComment[]> {
        const reviews: ReviewComment[] = [];
        let buffer = '';

        for await (const chunk of response.text) {
            buffer += chunk;
            try {
                const jsonStart = buffer.indexOf('{');
                const jsonEnd = buffer.lastIndexOf('}') + 1;
                
                if (jsonStart !== -1 && jsonEnd > jsonStart) {
                    const review = JSON.parse(buffer.slice(jsonStart, jsonEnd));
                    if (this.isValidReview(review)) {
                        const document = await this.getDocument(review.filePath);
                        if (document && review.line > 0 && review.line <= document.lineCount) {
                            const line = document.lineAt(review.line - 1);
                            const codePosition = this.findCodePosition(line.text, review.code);
                            
                            if (codePosition) {
                                review.range = new vscode.Range(
                                    review.line - 1, codePosition.start,
                                    review.line - 1, codePosition.end
                                );
                                reviews.push(review);
                            }
                        }
                    }
                    buffer = buffer.slice(jsonEnd);
                }
            } catch (error) {
                continue;
            }
        }
        
        return reviews;
    }

    private async processDiagnostics(reviews: ReviewComment[]): Promise<void> {
        // Get all unique file paths from the current review
        const currentFilePaths = new Set(reviews.map(r => r.filePath));
        
        // Create a map for new diagnostics
        const newDiagnostics = new Map<string, vscode.Diagnostic[]>();

        // Process each file's reviews
        for (const [filePath, fileReviews] of this.groupReviewsByFile(reviews)) {
            try {
                const document = await this.getDocument(filePath);
                if (!document) {continue;}

                const diagnostics: vscode.Diagnostic[] = [];
                
                for (const review of fileReviews) {
                    if (!this.isValidLineNumber(document, review.line)) {
                        continue;
                    }

                    const diagnostic = await this.createDiagnostic(document, review);
                    if (diagnostic) {
                        diagnostics.push(diagnostic);
                    }
                }

                // Store new diagnostics
                if (diagnostics.length > 0) {
                    newDiagnostics.set(filePath, diagnostics);
                }
            } catch (error) {
                // Handle error silently
            }
        }

        // Clear existing diagnostics
        this.diagnosticCollection.clear();

        // Update the cache with new diagnostics
        this.cachedDiagnostics = newDiagnostics;

        // Set new diagnostics for all files
        if (this.isVisible) {
            for (const [filePath, diagnostics] of newDiagnostics) {
                const uri = this.getUriForFilePath(filePath);
                this.diagnosticCollection.set(uri, diagnostics);
            }
        }
    }

    private groupReviewsByFile(reviews: ReviewComment[]): Map<string, ReviewComment[]> {
        const reviewsByFile = new Map<string, ReviewComment[]>();
        for (const review of reviews) {
            const existing = reviewsByFile.get(review.filePath) || [];
            existing.push(review);
            reviewsByFile.set(review.filePath, existing);
        }
        return reviewsByFile;
    }

    private getUriForFilePath(filePath: string): vscode.Uri {
        return vscode.Uri.file(
            path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath)
        );
    }

    private updateDiagnostics() {
        if (!this.isVisible) {
            this.diagnosticCollection.clear();
            return;
        }

        for (const [filePath, diagnostics] of this.cachedDiagnostics) {
            const uri = this.getUriForFilePath(filePath);
            this.diagnosticCollection.set(uri, diagnostics);
        }
    }

    hideAllDiagnostics() {
        this.isVisible = false;
        this.diagnosticCollection.clear();
    }

    showAllDiagnostics() {
        this.isVisible = true;
        this.updateDiagnostics();
    }

    getDiagnosticsVisibility(): boolean {
        return this.isVisible;
    }

    private isValidLineNumber(document: vscode.TextDocument, line: number): boolean {
        return line > 0 && line <= document.lineCount;
    }

    private async createDiagnostic(document: vscode.TextDocument, review: ReviewComment): Promise<vscode.Diagnostic | null> {
        try {
            const line = document.lineAt(review.line - 1);
            const codePosition = this.findCodePosition(line.text, review.code);
            if (!codePosition) {return null;}

            const range = new vscode.Range(
                review.line - 1, codePosition.start,
                review.line - 1, codePosition.end
            );

            // Create diagnostic with additional properties
            const diagnostic: vscode.Diagnostic = {
                range,
                message: this.formatDiagnosticMessage(review),
                severity: this.getSeverity(review.severity),
                source: DIAGNOSTIC_SOURCE,
                code: {
                    value: review.code,
                    target: document.uri.with({ fragment: `L${review.line}` })
                },
                tags: this.getDiagnosticTags(review.severity),
            };

            return diagnostic;
        } catch (error) {
            return null;
        }
    }

    private getDiagnosticTags(severity: string): vscode.DiagnosticTag[] {
        const tags: vscode.DiagnosticTag[] = [];
        if (severity === 'warning') {
            tags.push(vscode.DiagnosticTag.Unnecessary);
        }
        return tags;
    }

    private findCodePosition(lineText: string, code: string): { start: number; end: number } | null {
        const start = lineText.indexOf(code);
        if (start === -1) {return null;}
        
        return {
            start,
            end: start + code.length
        };
    }

    private formatDiagnosticMessage(review: ReviewComment): string {
        return review.message;
    }

    private getSeverity(severity: string): vscode.DiagnosticSeverity {
        const severityMap: Record<string, vscode.DiagnosticSeverity> = {
            'error': vscode.DiagnosticSeverity.Error,
            'warning': vscode.DiagnosticSeverity.Warning,
            'info': vscode.DiagnosticSeverity.Information
        };
        return severityMap[severity] ?? vscode.DiagnosticSeverity.Information;
    }

    private isValidReview(review: any): review is ReviewComment {
        return review.filePath && 
                typeof review.line === 'number' && 
                review.message &&
                ['error', 'warning', 'info'].includes(review.severity) &&
                typeof review.code === 'string';
    }

    private async getDocument(filePath: string): Promise<vscode.TextDocument | undefined> {
        try {
            const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath);
            return await vscode.workspace.openTextDocument(fullPath);
        } catch (error) {
            return undefined;
        }
    }

    private async getCopilotModel() {
        try {
            const [model] = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4o'
            });
            return model;
        } catch (error) {
            return null;
        }
    }

    private getRandomPraiseMessage(): string {
        const praiseMessages = PEAR_MESSAGES.praise;
        return praiseMessages[Math.floor(Math.random() * praiseMessages.length)];
    }

    dispose() {
        this.diagnosticCollection.dispose();
        this.previousReviews.clear();
    }
}


/**
 * Checks and validates prerequisites for the extension
 */
export class PrerequisiteService {
    private readonly MAX_RETRIES = 5;
    private readonly RETRY_DELAY = 1000;
    private hasChecked = false;

    constructor(private gitService: GitService) {}

    async checkAll(): Promise<boolean> {
        try {
            // Only show messages on first check
            const isFirstCheck = !this.hasChecked;
            this.hasChecked = true;

            // Check git first
            const isGitAvailable = await this.checkGitSetup();
            if (!isGitAvailable) {
                if (isFirstCheck) {
                    vscode.window.showErrorMessage('🍐 I need Git to review your code. Is Git installed?');
                }
                return false;
            }

            // Then check language model with retries
            const isLanguageModelAvailable = await this.checkLanguageModelWithRetry();
            if (!isLanguageModelAvailable) {
                if (isFirstCheck) {
                    vscode.window.showErrorMessage('🍐 I need GitHub Copilot to help review your code. Is it installed, enabled, and ready?');
                }
                return false;
            }

            return true;
        } catch (error) {
            return false;
        }
    }

    private async checkGitSetup(): Promise<boolean> {
        const isGitAvailable = await this.gitService.initialize();
        if (!isGitAvailable) {
            vscode.window.showErrorMessage('🍐 I need Git to review your code. Is Git installed?');
            return false;
        }
        return true;
    }

    private async checkLanguageModelWithRetry(): Promise<boolean> {
        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            const isAvailable = await this.checkLanguageModel();
            if (isAvailable) {
                return true;
            }
            if (attempt < this.MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            }
        }
        return false;
    }

    private async checkLanguageModel(): Promise<boolean> {
        try {
            const [model] = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4'
            });
            return !!model;
        } catch (error) {
            return false;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Collection of friendly messages used by the Pear */
const PEAR_MESSAGES = {
    greetings: [
        "Hey there! Your friendly Pear pal is here to help! 🍐",
        "Ready to make your code pear-fectly amazing! 🍐",
        "Let's grow something wonderful together! 🍐",
        "Time for some fruitful collaboration! 🍐"
    ],
    progress: [
        "Taking a sweet look at your code 🌱",
        "Finding the juiciest improvements",
        "Carefully tending to your changes",
        "Helping your code bloom and grow",
        "Sprinkling some pear-fection",
        "Adding a dash of coding magic",
        "Making everything fresh and crisp",
        "Nurturing your code with care",
        "Bringing out the best flavors",
        "Preparing some pear-ticular insights"
    ],
    praise: [
        "This part is looking pear-fectly structured! 🌟",
        "Ooh, loving this clean code approach! ✨",
        "You've really planted some great ideas here! 🌱",
        "This solution is ripe with potential! 🍐"
    ],
    errors: [
        "Oopsie! Even the juiciest pears drop sometimes! Let's fix this together 🍐",
        "Don't worry! Every tree starts as a seed. We'll sort this out! 🌱",
        "Just a tiny bump - nothing we can't handle together! 🤝"
    ]
};

const DIAGNOSTIC_SOURCE = '🍐 Pear Review';

const REVIEW_PROMPT = `You are the Friendly Neighborhood Pear (🍐), a kind and empathetic code review assistant.
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
    "code": string,        // The specific problematic code
    "message": string,     // Friendly, encouraging explanation
    "severity": "error" | "warning" | "info",
    "suggestions": [       // Array of specific code fixes
        {
            "description": string,  // What this fix does
            "code": string          // The actual code to replace with
        }
    ],
    "praise": string      // Something positive about the code (optional)
}

Remember to:
1. Error:   "Critical issues that need immediate attention"
2. Warning: "Suggestions for improvement"
3. Info:    "Friendly tips and best practices"

Always be encouraging and supportive!`;

// ═══════════════════════════════════════════════════════════════════════════
// Main Controller
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main controller for the Pear Review extension.
 * Manages the lifecycle and coordinates between services.
 */
class PearReviewController {
    private readonly reviewService: ReviewService;
    private readonly prerequisiteService: PrerequisiteService;
    private readonly gitService: GitService;
    private readonly statusItems: {
        review: vscode.StatusBarItem;
        diagnostic: vscode.StatusBarItem;
    };
    
    private autoSaveDisposable: vscode.Disposable | undefined;
    private reviewDebounceTimer: NodeJS.Timeout | undefined;
    private isDiagnosticsVisible: boolean = true;

    constructor(private context: vscode.ExtensionContext) {
        this.gitService = new GitService();
        this.prerequisiteService = new PrerequisiteService(this.gitService);
        this.reviewService = new ReviewService();

        // Initialize and show status bar items
        this.statusItems = {
            review: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100),
            diagnostic: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
        };

        this.statusItems.review.name = "Pear Review";
        this.statusItems.review.text = "$(checklist) Review";
        this.statusItems.review.tooltip = "Let your friendly Pear review your code changes";
        this.statusItems.review.command = 'pear-review.reviewChanges';
        this.statusItems.review.show();

        this.statusItems.diagnostic.name = "Pear Review Review Comments";
        this.updateDiagnosticStatusBar();
        this.statusItems.diagnostic.command = 'pear-review.toggleReviewComments';

        context.subscriptions.push(this.statusItems.review, this.statusItems.diagnostic);

        // Initially assume ready, will check on first use
        vscode.commands.executeCommand('setContext', 'pearReview.isReady', true);
        
        // Setup auto-review configuration watcher
        this.setupAutoReview();

        // Initialize diagnostics visibility
        this.updateDiagnosticVisibility();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Public Methods
    // ═══════════════════════════════════════════════════════════════════════

    /** Initiates review of changed files */
    async reviewChanges(): Promise<void> {
        this.updateStatusBarProgress('checking');
        
        // Run prerequisite check when review is requested
        if (!await this.prerequisiteService.checkAll()) {
            this.updateStatusBarProgress('error');
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "🍐 Your friendly Pear is reviewing",
                cancellable: true
            }, async (progress) => {
                this.updateStatusBarProgress('reviewing');

                // Get changed files
                progress.report({ message: "Gathering fresh changes 🌱", increment: 20 });
                const changes = await this.gitService.getChangedFiles();
                
                if (changes.length === 0) {
                    vscode.window.showInformationMessage("No changes found.");
                    this.updateStatusBarProgress('ready');
                    return;
                }

                // Prepare files
                progress.report({ message: "Preparing files", increment: 20 });
                
                // Start review
                progress.report({ message: "Starting review", increment: 20 });
                await this.performReview(changes, progress);

                this.updateStatusBarProgress('done');
            });
        } catch (error) {
            this.updateStatusBarProgress('error');
            vscode.window.showErrorMessage("An error occurred while reviewing changes.");
        }
    }

    /** Toggles auto-review feature */
    async toggleAutoReview(): Promise<void> {
        const config = vscode.workspace.getConfiguration('pearReview');
        const currentValue = config.get<boolean>('autoReview');
        await config.update('autoReview', !currentValue, true);
        
        vscode.window.showInformationMessage(
            !currentValue ? 
            "🍐 I'll now automatically review your code when you save!" :
            "🍐 Auto-review disabled. Click the pear icon when you want a review!"
        );
    }

    /** Toggles visibility of review diagnostics */
    async toggleReviewComments(): Promise<void> {
        this.isDiagnosticsVisible = !this.isDiagnosticsVisible;
        this.updateDiagnosticVisibility();
        this.updateDiagnosticStatusBar();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Private Methods
    // ═══════════════════════════════════════════════════════════════════════

    /** Sets up auto-review configuration and watchers */
    private setupAutoReview(): void {
        // Watch for configuration changes
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('pearReview.autoReview')) {
                    this.updateAutoReviewWatcher();
                }
            })
        );

        // Initial setup
        this.updateAutoReviewWatcher();
    }

    /** Updates the auto-review watcher based on configuration */
    private updateAutoReviewWatcher(): void {
        const config = vscode.workspace.getConfiguration('pearReview');
        const isAutoReviewEnabled = config.get<boolean>('autoReview', false);

        if (isAutoReviewEnabled) {
            if (!this.autoSaveDisposable) {
                this.autoSaveDisposable = vscode.workspace.onDidSaveTextDocument(
                    this.handleDocumentSave.bind(this)
                );
                this.context.subscriptions.push(this.autoSaveDisposable);
            }
        } else {
            if (this.autoSaveDisposable) {
                this.autoSaveDisposable.dispose();
                this.autoSaveDisposable = undefined;
            }
        }
    }

    /** Handles document save events for auto-review */
    private async handleDocumentSave(document: vscode.TextDocument): Promise<void> {
        // Quick early return if not file scheme
        if (document.uri.scheme !== 'file') {
            return;
        }
        try {
            // Don't review if git isn't ready
            if (!await this.checkPrerequisites()) {
                return;
            }

            // Check if file is in git
            const changes = await this.gitService.getChangedFiles();
            const isGitTracked = changes.some(change => 
                change.uri.fsPath === document.uri.fsPath
            );

            if (!isGitTracked) {
                return;
            }

            // Debounce the review
            if (this.reviewDebounceTimer) {
                clearTimeout(this.reviewDebounceTimer);
            }

            this.reviewDebounceTimer = setTimeout(async () => {
                await this.performAutoReview([document]);
            }, 1000);

        } catch (error) {
            vscode.window.showErrorMessage("An error occurred while saving the document.");
        }
    }

    /** Performs an automatic review of the given documents */
    private async performAutoReview(documents: ReviewTarget): Promise<void> {
        this.updateStatusBarProgress('reviewing');

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "🍐 Auto-reviewing your changes",
                cancellable: false
            }, async (progress) => {
                let messageIndex = 0;
                const progressInterval = setInterval(() => {
                    progress.report({ 
                        message: PEAR_MESSAGES.progress[messageIndex % PEAR_MESSAGES.progress.length],
                        increment: 5
                    });
                    messageIndex++;
                }, 2500);

                try {
                    const files = await this.prepareFilesForReview(documents);
                    // No need to re-check files.length again if we exit early
                    if (files.length === 0) {
                        this.updateStatusBarProgress('ready');
                        clearInterval(progressInterval);
                        return;
                    }

                    progress.report({ message: "Analyzing your fresh changes 🔍", increment: 30 });
                    await this.reviewService.reviewFiles(files);
                    progress.report({ message: "Adding pear-fect suggestions ✨", increment: 20 });
                    
                    // Don't show completion message, but update status bar
                    this.updateStatusBarProgress('done');
                } finally {
                    clearInterval(progressInterval);
                }
            });
        } catch (error) {
            this.updateStatusBarProgress('error');
            vscode.window.showErrorMessage("An error occurred during the auto-review process.");
        }
    }

    /** Checks if all prerequisites are met */
    async checkPrerequisites(): Promise<boolean> {
        try {
            const ready = await this.prerequisiteService.checkAll();
            // Update global readiness state
            vscode.commands.executeCommand('setContext', 'pearReview.isReady', ready);
            return ready;
        } catch (error) {
            vscode.commands.executeCommand('setContext', 'pearReview.isReady', false);
            return false;
        }
    }

    /** Updates the status bar progress indicator */
    private updateStatusBarProgress(state: 'ready' | 'checking' | 'reviewing' | 'done' | 'error'): void {
        switch (state) {
            case 'ready':
                this.statusItems.review.text = "$(checklist) Review";
                this.statusItems.review.tooltip = "Let Pear review your code changes";
                this.statusItems.review.backgroundColor = undefined;
                break;
            case 'checking':
                this.statusItems.review.text = "$(sync~spin) Checking";
                this.statusItems.review.tooltip = "Your friendly Pear is checking prerequisites";
                break;
            case 'reviewing':
                this.statusItems.review.text = "$(sync~spin) Reviewing";
                this.statusItems.review.tooltip = "Your friendly Pear is reviewing your code";
                break;
            case 'done':
                this.statusItems.review.text = "$(check) Review Complete";
                this.statusItems.review.tooltip = "Pear has completed the review!";
                setTimeout(() => this.updateStatusBarProgress('ready'), 3000);
                break;
            case 'error':
                this.statusItems.review.text = "$(error) Review Failed";
                this.statusItems.review.tooltip = "Something went wrong during the review";
                setTimeout(() => this.updateStatusBarProgress('ready'), 5000);
                break;
        }
    }

    /** Determines if the given object is a text document */
    private isTextDocument(doc: unknown): doc is vscode.TextDocument {
        return (
            doc !== null &&
            typeof doc === 'object' &&
            typeof (doc as vscode.TextDocument).getText === 'function' &&
            !!(doc as vscode.TextDocument).uri
        );
    }

    /** Determines if the given object is a source control state */
    private isSourceControlState(doc: unknown): doc is vscode.SourceControlResourceState {
        return (
            doc !== null &&
            typeof doc === 'object' &&
            'resourceUri' in doc
        );
    }

    /** Performs a review of the given documents */
    private async performReview(documents: ReviewTarget, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        const files = await this.prepareFilesForReview(documents);
        if (files.length === 0) {
            vscode.window.showInformationMessage("🍐 I couldn't find any files to review!");
            return;
        }

        let messageIndex = 0;
        const progressInterval = setInterval(() => {
            progress.report({ 
                message: PEAR_MESSAGES.progress[messageIndex % PEAR_MESSAGES.progress.length],
                increment: 5
            });
            messageIndex++;
        }, 2500);

        try {
            progress.report({ message: "Analyzing code", increment: 20 });
            await this.reviewService.reviewFiles(files);
            progress.report({ message: "Finalizing review", increment: 20 });
            
            // Show diagnostics toggle but maintain visibility state
            this.statusItems.diagnostic.show();
        } finally {
            clearInterval(progressInterval);
        }
    }

    /** Prepares files for review from the given documents */
    private async prepareFilesForReview(documents: ReviewTarget): Promise<{ uri: vscode.Uri, content: string }[]> {
        const files: { uri: vscode.Uri, content: string }[] = [];

        for (const doc of documents) {
            try {
                if (this.isTextDocument(doc)) {
                    files.push({
                        uri: doc.uri,
                        content: doc.getText()
                    });
                } else if (this.isSourceControlState(doc)) {
                    const textDoc = await vscode.workspace.openTextDocument(doc.resourceUri);
                    files.push({
                        uri: doc.resourceUri,
                        content: textDoc.getText()
                    });
                } else if ('uri' in doc) { // FileChange
                    const textDoc = await vscode.workspace.openTextDocument(doc.uri);
                    files.push({
                        uri: doc.uri,
                        content: textDoc.getText()
                    });
                }
            } catch (error) {
            }
        }

        return files;
    }

    /** Updates the visibility of diagnostics */
    private updateDiagnosticVisibility(): void {
        if (this.isDiagnosticsVisible) {
            this.reviewService.showAllDiagnostics();
        } else {
            this.reviewService.hideAllDiagnostics();
        }
    }

    /** Updates the diagnostic status bar item */
    private updateDiagnosticStatusBar(): void {
        this.statusItems.diagnostic.text = this.isDiagnosticsVisible
            ? "$(eye) Review Comments"
            : "$(eye-closed) Review Comments";
        this.statusItems.diagnostic.tooltip = this.isDiagnosticsVisible
            ? "Click to hide Pear's review comments"
            : "Click to show Pear's review comments";
    }

    /** Cleans up resources */
    dispose(): void {
        this.statusItems.review.dispose();
        this.statusItems.diagnostic.dispose();
        if (this.reviewDebounceTimer) {
            clearTimeout(this.reviewDebounceTimer);
        }
        if (this.autoSaveDisposable) {
            this.autoSaveDisposable.dispose();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry Points
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Activates the extension and sets up the Pear Review controller
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const controller = new PearReviewController(context);
    
    context.subscriptions.push(
        vscode.commands.registerCommand('pear-review.reviewChanges', () => 
            controller.reviewChanges()
        ),
        vscode.commands.registerCommand('pear-review.toggleAutoReview', () =>
            controller.toggleAutoReview()
        ),
        vscode.commands.registerCommand('pear-review.toggleReviewComments', () =>
            controller.toggleReviewComments()
        )
    );
}

/**
 * Handles extension deactivation
 */
export function deactivate(): void {}
