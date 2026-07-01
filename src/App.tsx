import { useState, useEffect, useCallback } from 'react';
import EnrollmentWizard from './components/EnrollmentWizard';
import PasswordEncryptionTool from './components/PasswordEncryptionTool';
import ThankYouPage from './components/ThankYouPage';
import DocumentPdfModal from './components/DocumentPdfModal';

const PRIVACY_POLICY_PDF = `/assets/${encodeURIComponent('Sedera HealthShare Privacy Policy.pdf')}`;

function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [benefitId, setBenefitId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('id') || '768413';
  });
  const [employeeGroup, setEmployeeGroup] = useState<string | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('employeegroup');
  });
  const [wizardKey, setWizardKey] = useState<number>(Date.now());
  const [privacyPolicyOpen, setPrivacyPolicyOpen] = useState(false);
  const closePrivacyModal = useCallback(() => setPrivacyPolicyOpen(false), []);

  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        if (sessionStorage.getItem('form_submitting')) return;
        setBenefitId(null);
        setWizardKey(Date.now());
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  useEffect(() => {
    const checkUrlParams = () => {
      setCurrentPath(window.location.pathname);
      const urlParams = new URLSearchParams(window.location.search);
      const agentIdParam = urlParams.get('id');
      const newAgentId = agentIdParam || '768413';

      if (newAgentId !== agentId) {
        setAgentId(newAgentId);
      }

      setEmployeeGroup(urlParams.get('employeegroup'));
    };

    checkUrlParams();

    const handlePopState = () => {
      checkUrlParams();
    };

    window.addEventListener('popstate', handlePopState);

    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    window.history.pushState = function(...args) {
      originalPushState.apply(window.history, args);
      checkUrlParams();
    };

    window.history.replaceState = function(...args) {
      originalReplaceState.apply(window.history, args);
      checkUrlParams();
    };

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    };
  }, [agentId]);

  const handleBenefitIdChange = (newBenefitId: string) => {
    setBenefitId(newBenefitId);
  };

  if (currentPath === '/encrypt') {
    return <PasswordEncryptionTool />;
  }

  if (import.meta.env.DEV && currentPath === '/preview-listbill-thankyou') {
    return (
      <ThankYouPage
        enrollmentData={{ firstName: 'Jane', email: 'jane.doe@example.com' }}
        listBill={{ productName: 'Premium HSA' }}
      />
    );
  }

  return (
    <>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col">
        <div className="flex-grow py-12 px-0 xs:px-4">
          <EnrollmentWizard
            key={wizardKey}
            benefitId={benefitId}
            onBenefitIdChange={handleBenefitIdChange}
            agentId={agentId}
            employeeGroup={employeeGroup}
          />
        </div>
        <footer className="bg-white border-t border-gray-200 py-6 px-4">
          <div className="max-w-4xl mx-auto">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 bg-blue-100 rounded-lg">
                  <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">HIPAA Compliant</p>
                  <p className="text-xs text-gray-600">Your information is secure and protected</p>
                </div>
              </div>
              <div className="text-center md:text-right w-full md:w-auto">
                <div className="flex flex-wrap items-center justify-center md:justify-end gap-x-2 gap-y-1">
                  <p className="text-xs text-gray-600">
                    © {new Date().getFullYear()} MPB Health. All rights reserved.
                  </p>
                  <span className="hidden sm:inline text-xs text-gray-400" aria-hidden="true">
                    |
                  </span>
                  <button
                    type="button"
                    onClick={() => setPrivacyPolicyOpen(true)}
                    className="text-xs text-gray-500 hover:text-gray-600 hover:underline p-0 m-0 bg-transparent border-0 cursor-pointer font-normal"
                  >
                    Sedera Legal - Privacy Policy
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Ensuring privacy and compliance with health information regulations
                </p>
              </div>
            </div>
          </div>
        </footer>
      </div>

      <DocumentPdfModal
        open={privacyPolicyOpen}
        onClose={closePrivacyModal}
        pdfSrc={PRIVACY_POLICY_PDF}
        title="Sedera Legal - Privacy Policy"
        iframeTitle="Sedera HealthShare Privacy Policy PDF"
        closeAriaLabel="Close privacy policy"
        titleId="app-privacy-policy-modal-title"
      />
    </>
  );
}

export default App;
