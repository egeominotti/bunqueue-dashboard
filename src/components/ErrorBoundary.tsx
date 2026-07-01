import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/feedback';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors from the subtree so a single throw does not
 * unmount the whole app (blank screen). Renders a design-system fallback with
 * the error message and a Reload button.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught an error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6">
          <Card className="w-full max-w-lg">
            <ErrorState error={error} />
            <div className="mt-4 flex justify-center">
              <Button onClick={() => window.location.reload()}>Reload</Button>
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
