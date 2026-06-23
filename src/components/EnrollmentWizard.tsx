import { useState, useEffect } from 'react';
import { useEnrollmentStorage, Dependent, PaymentInfo, QuestionnaireAnswers, AppliedPromo } from '../hooks/useEnrollmentStorage';
import { getSecureHsaPricingOptions, calculateAgeFromDOB } from '../utils/pricingLogic';
import { generateEnrollmentPDF } from '../utils/generateEnrollmentPDF';
import { encryptSensitiveFields } from '../utils/payloadEncryption';
import { getDependentEmailDuplicateError } from '../utils/dependentEmailValidation';
import {
  getDependentPhoneDuplicateError,
  getDependentSsnDuplicateError,
  getPrimarySubscriberPhoneDuplicateError,
  getPrimarySubscriberSsnDuplicateError,
} from '../utils/dependentPhoneSsnDuplicateValidation';
import {
  isPremiumHsaUnavailableState,
  PREMIUM_HSA_UNAVAILABLE_STATE_MESSAGE,
} from '../utils/premiumHsaUnavailableStates';
import { isChildDependentUnder18ForContactOptional } from '../utils/dependentAgeValidation';
import {
  getOrCreateSubmissionId,
  clearSubmissionId,
  fetchSubmissionStatus,
} from '../utils/enrollmentSubmission';
import ProgressIndicator from './ProgressIndicator';
import Step1PersonalInfo from './Step1PersonalInfo';
import Step2Questionnaire from './Step2Questionnaire';
import Step2AddressInfo from './Step2AddressInfo';
import ThankYouPage from './ThankYouPage';

interface ApiResponse {
  success: boolean;
  status: number;
  data?: any;
  error?: string;
  message?: string;
}

interface EnrollmentWizardProps {
  benefitId: string | null;
  onBenefitIdChange: (benefitId: string) => void;
  agentId: string;
  employeeGroup?: string | null;
}

export default function EnrollmentWizard({ benefitId, onBenefitIdChange, agentId, employeeGroup = null }: EnrollmentWizardProps) {
  const { formData, currentStep, saveFormData, patchFormData, saveStep, clearStorage, clearFormDataOnly } =
    useEnrollmentStorage(benefitId, agentId);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [finishingEnrollment, setFinishingEnrollment] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [showThankYou, setShowThankYou] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [invalidDependentIndices, setInvalidDependentIndices] = useState<number[]>([]);
  const [instanceId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const previous = sessionStorage.getItem('enrollment_instance');
    const isSubmitting = sessionStorage.getItem('form_submitting');
    if (previous && previous !== instanceId && !isSubmitting) {
      clearStorage();
    }
    sessionStorage.setItem('enrollment_instance', instanceId);

    return () => {
      sessionStorage.removeItem('enrollment_instance');
    };
  }, [instanceId, clearStorage]);

  useEffect(() => {
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
  }, [currentStep]);


  const formatDateInput = (value: string): string => {
    const digitsOnly = value.replace(/\D/g, '');

    if (digitsOnly.length <= 2) {
      return digitsOnly;
    } else if (digitsOnly.length <= 4) {
      return `${digitsOnly.slice(0, 2)}/${digitsOnly.slice(2)}`;
    } else {
      return `${digitsOnly.slice(0, 2)}/${digitsOnly.slice(2, 4)}/${digitsOnly.slice(4, 8)}`;
    }
  };

  const validateDateInput = (value: string): boolean => {
    if (value.length !== 10) return false;

    const [month, day, year] = value.split('/').map(num => parseInt(num, 10));

    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    if (year < 1925 || year > 2025) return false;

    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) return false;

    return true;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;

    let updatedData = { ...formData, [name]: value };

    if (name === 'dob') {
      const updatedProducts = formData.products.map(product =>
        product.id === 'secure-hsa'
          ? { ...product, selectedPlan: '', extractedBenefitId: undefined, extractedPrice: undefined }
          : product
      );
      updatedData = { ...updatedData, products: updatedProducts };
    }

    saveFormData(updatedData);

    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
    if (name === 'dob' && errors.essentialPlan) {
      setErrors(prev => ({ ...prev, essentialPlan: '' }));
    }
  };

  const handleClearError = (field: string) => {
    setErrors(prev => {
      const newErrors = { ...prev };
      delete newErrors[field];
      return newErrors;
    });
  };

  const validateStep1 = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.firstName.trim()) newErrors.firstName = 'First name is required';
    if (!formData.lastName.trim()) newErrors.lastName = 'Last name is required';
    if (!formData.dob.trim()) {
      newErrors.dob = 'Date of birth is required';
    } else if (!validateDateInput(formData.dob)) {
      newErrors.dob = 'Invalid date. Please enter a valid date in MM/DD/YYYY format';
    } else {
      const age = calculateAgeFromDOB(formData.dob);
      if (age !== null && age < 18) {
        newErrors.dob = 'Must be 18 years or older to enroll';
      }
    }
    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }
    if (!formData.smoker.trim()) newErrors.smoker = 'Smoker status is required';

    formData.dependents.forEach((dependent, index) => {
      const prefix = `dependent_${index}_`;
      if (!dependent.firstName.trim()) newErrors[`${prefix}firstName`] = 'First name is required';
      if (!dependent.lastName.trim()) newErrors[`${prefix}lastName`] = 'Last name is required';
      if (!dependent.dob.trim()) {
        newErrors[`${prefix}dob`] = 'Date of birth is required';
      } else if (!validateDateInput(dependent.dob)) {
        newErrors[`${prefix}dob`] = 'Invalid date. Please enter a valid date in MM/DD/YYYY format';
      } else {
        const age = calculateAgeFromDOB(dependent.dob);
        if (dependent.relationship === 'Spouse') {
          if (age !== null && age < 18) {
            newErrors[`${prefix}dob`] = 'Must be 18 years or older to enroll';
          }
        } else if (dependent.relationship === 'Child') {
          if (age !== null && age >= 26) {
            newErrors[`${prefix}dob`] = 'Child dependents must be under 26 years of age';
          }
        }
      }
      if (!dependent.smoker.trim()) newErrors[`${prefix}smoker`] = 'Smoker status is required';
    });

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      const firstErrorKey = Object.keys(newErrors)[0];
      setTimeout(() => {
        const errorElement = document.querySelector(`[name="${firstErrorKey}"]`) as HTMLElement;
        if (errorElement) {
          errorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          errorElement.focus();
        }
      }, 100);
    }

    return Object.keys(newErrors).length === 0;
  };

  const validateStep3 = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.address1.trim()) newErrors.address1 = 'Address is required';
    if (!formData.city.trim()) newErrors.city = 'City is required';
    if (!formData.state.trim()) {
      newErrors.state = 'State is required';
    } else if (isPremiumHsaUnavailableState(formData.state)) {
      newErrors.state = PREMIUM_HSA_UNAVAILABLE_STATE_MESSAGE;
    }
    if (!formData.zipcode.trim()) {
      newErrors.zipcode = 'Zipcode is required';
    } else if (formData.zipcode.length !== 5 || !/^\d{5}$/.test(formData.zipcode)) {
      newErrors.zipcode = 'Zipcode must be exactly 5 digits';
    }
    if (!formData.phone.trim()) {
      newErrors.phone = 'Phone number is required';
    } else {
      const phoneDigits = formData.phone.replace(/\D/g, '');
      if (phoneDigits.length !== 10) {
        newErrors.phone = 'Phone number must be exactly 10 digits';
      } else if (formData.dependents.length > 0) {
        const phoneDup = getPrimarySubscriberPhoneDuplicateError(formData.phone, formData.dependents);
        if (phoneDup) {
          newErrors.phone = phoneDup;
        }
      }
    }
    if (!formData.ssn.trim()) {
      newErrors.ssn = 'Social Security number is required';
    } else {
      const ssnDigits = formData.ssn.replace(/\D/g, '');
      if (ssnDigits.length !== 9) {
        newErrors.ssn = 'Social Security number must be exactly 9 digits';
      } else if (formData.dependents.length > 0) {
        const ssnDup = getPrimarySubscriberSsnDuplicateError(formData.ssn, formData.dependents);
        if (ssnDup) {
          newErrors.ssn = ssnDup;
        }
      }
    }
    if (!formData.gender.trim()) newErrors.gender = 'Gender is required';
    if (!formData.effectiveDate.trim()) newErrors.effectiveDate = 'Effective date is required';
    if (!formData.preExistingConditionsAcknowledged.trim()) {
      newErrors.preExistingConditionsAcknowledged = 'You must acknowledge the pre-existing conditions terms';
    }

    if (formData.payment.paymentMethod === 'credit-card') {
      if (!formData.payment.ccType.trim()) newErrors.ccType = 'Card type is required';
      if (!formData.payment.ccNumber.trim()) {
        newErrors.ccNumber = 'Card number is required';
      } else if (formData.payment.ccNumber.length < 15 || formData.payment.ccNumber.length > 16) {
        newErrors.ccNumber = 'Invalid card number length';
      }
      if (!formData.payment.ccExpMonth.trim()) newErrors.ccExpMonth = 'Expiration month is required';
      if (!formData.payment.ccExpYear.trim()) {
        newErrors.ccExpYear = 'Expiration year is required';
      } else {
        const currentYear = new Date().getFullYear() % 100;
        const currentMonth = new Date().getMonth() + 1;
        const expYear = parseInt(formData.payment.ccExpYear);
        const expMonth = parseInt(formData.payment.ccExpMonth);
        if (expYear < currentYear || (expYear === currentYear && expMonth < currentMonth)) {
          newErrors.ccExpYear = 'Card has expired';
        }
      }
    } else if (formData.payment.paymentMethod === 'ach') {
      if (!formData.payment.achrouting.trim()) {
        newErrors.achrouting = 'Routing number is required';
      } else if (formData.payment.achrouting.length !== 9) {
        newErrors.achrouting = 'Routing number must be exactly 9 digits';
      }
      if (!formData.payment.achaccount.trim()) {
        newErrors.achaccount = 'Account number is required';
      }
      if (!formData.payment.achbank.trim()) {
        newErrors.achbank = 'Bank name is required';
      }
    } else if (formData.payment.paymentMethod === 'list-bill') {
      // List Bill requires no card or bank details.
    }

    const invalidIndices: number[] = [];
    formData.dependents.forEach((dependent, index) => {
      const prefix = `dependent_${index}_`;
      let hasError = false;

      // Only validate address fields if NOT using same address as subscriber
      if (!dependent.useSameAddress) {
        if (!dependent.address?.trim()) {
          newErrors[`${prefix}address`] = 'Address is required';
          hasError = true;
        }
        if (!dependent.city?.trim()) {
          newErrors[`${prefix}city`] = 'City is required';
          hasError = true;
        }
        if (!dependent.state?.trim()) {
          newErrors[`${prefix}state`] = 'State is required';
          hasError = true;
        }
        if (!dependent.zipcode?.trim()) {
          newErrors[`${prefix}zipcode`] = 'Zipcode is required';
          hasError = true;
        } else if (dependent.zipcode.length !== 5 || !/^\d{5}$/.test(dependent.zipcode)) {
          newErrors[`${prefix}zipcode`] = 'Zipcode must be exactly 5 digits';
          hasError = true;
        }
      }

      const skipContactRequired = isChildDependentUnder18ForContactOptional(
        dependent.dob,
        dependent.relationship
      );

      const emailTrimmed = dependent.email?.trim() || '';
      if (!emailTrimmed) {
        if (!skipContactRequired) {
          newErrors[`${prefix}email`] = 'Email address is required';
          hasError = true;
        }
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
        newErrors[`${prefix}email`] = 'Email address must be valid';
        hasError = true;
      } else {
        const duplicateMsg = getDependentEmailDuplicateError(
          dependent.email,
          index,
          formData.dependents,
          formData.email
        );
        if (duplicateMsg) {
          newErrors[`${prefix}email`] = duplicateMsg;
          hasError = true;
        }
      }

      const phoneTrimmed = dependent.phone?.trim() || '';
      if (!phoneTrimmed) {
        if (!skipContactRequired) {
          newErrors[`${prefix}phone`] = 'Phone number is required';
          hasError = true;
        }
      } else {
        const phoneDigits = phoneTrimmed.replace(/\D/g, '');
        if (phoneDigits.length !== 10) {
          newErrors[`${prefix}phone`] = 'Phone must be exactly 10 digits';
          hasError = true;
        } else {
          const dupPhone = getDependentPhoneDuplicateError(
            dependent.phone,
            index,
            formData.dependents,
            formData.phone
          );
          if (dupPhone) {
            newErrors[`${prefix}phone`] = dupPhone;
            hasError = true;
          }
        }
      }

      const ssnTrimmed = dependent.ssn?.trim() || '';
      if (!ssnTrimmed) {
        if (!skipContactRequired) {
          newErrors[`${prefix}ssn`] = 'Social Security is required';
          hasError = true;
        }
      } else {
        const ssnDigits = ssnTrimmed.replace(/\D/g, '');
        if (ssnDigits.length !== 9) {
          newErrors[`${prefix}ssn`] = 'Social Security must be exactly 9 digits';
          hasError = true;
        } else {
          const dupSsn = getDependentSsnDuplicateError(
            dependent.ssn,
            index,
            formData.dependents,
            formData.ssn
          );
          if (dupSsn) {
            newErrors[`${prefix}ssn`] = dupSsn;
            hasError = true;
          }
        }
      }
      if (!dependent.gender?.trim()) {
        newErrors[`${prefix}gender`] = 'Gender is required';
        hasError = true;
      }

      if (hasError) {
        invalidIndices.push(index);
      }
    });

    setErrors(newErrors);
    setInvalidDependentIndices(invalidIndices);

    if (Object.keys(newErrors).length > 0) {
      const firstErrorKey = Object.keys(newErrors)[0];
      setTimeout(() => {
        let errorElement: HTMLElement | null = null;

        if (invalidIndices.length > 0 && firstErrorKey.startsWith('dependent_')) {
          const dependentsSection = document.querySelector('[data-dependents-section]') as HTMLElement;
          if (dependentsSection) {
            dependentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

        if (firstErrorKey === 'preExistingConditionsAcknowledged') {
          errorElement = document.querySelector(`[name="preExistingConditions"]`) as HTMLElement;
        } else {
          errorElement = document.querySelector(`[name="${firstErrorKey}"]`) as HTMLElement;
        }

        if (errorElement) {
          errorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          errorElement.focus();
        }
      }, 100);
    }

    const isValid = Object.keys(newErrors).length === 0;
    if (isValid) {
      setInvalidDependentIndices([]);
    }
    return isValid;
  };

  const handleNext = () => {
    if (!validateStep1()) {
      return;
    }

    const secureHsaProduct = formData.products.find(p => p.id === 'secure-hsa');
    if (secureHsaProduct) {
      const secureHsaPricing = getSecureHsaPricingOptions(formData.dob, formData.dependents);
      if (!secureHsaPricing.isAvailable) {
        setErrors({
          essentialPlan: secureHsaPricing.errorMessage || 'Invalid Premium HSA plan configuration',
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (!secureHsaProduct.selectedPlan) {
        setErrors({
          essentialPlan: 'Please select an IUA level for your Premium HSA membership',
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (!secureHsaProduct.extractedBenefitId) {
        setErrors({
          essentialPlan: 'Invalid IUA selection. Please select a valid IUA level.',
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    }

    saveStep(2);
    setErrors({});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const validateStep2 = (): boolean => {
    const newErrors: Record<string, string> = {};
    const answers = formData.questionnaireAnswers;

    if (!answers.businessTaxId.trim()) {
      newErrors.businessTaxId = 'Tax ID/EIN is required';
    } else {
      const taxIdDigits = answers.businessTaxId.replace(/\D/g, '');
      if (taxIdDigits.length !== 9) {
        newErrors.businessTaxId = 'Tax ID/EIN must be exactly 9 digits';
      }
    }

    if (!answers.zionPrinciplesAccept) newErrors.zionPrinciplesAccept = 'Please acknowledge Sedera Member Principles';
    if (!answers.zionm1a) newErrors.zionm1a = 'This field is required';
    if (!answers.zionm1b) newErrors.zionm1b = 'This field is required';
    if (!answers.zionm1d) newErrors.zionm1d = 'This field is required';
    if (!answers.zionmh2P) newErrors.zionmh2P = 'This field is required';
    if (!answers.maternityDeliveryAck) newErrors.maternityDeliveryAck = 'This field is required';
    if (!answers.primaryMemberConditionsPast36Mo) {
      newErrors.primaryMemberConditionsPast36Mo = 'This field is required';
    }
    if (!answers.medicalCostSharingAuth) newErrors.medicalCostSharingAuth = 'You must acknowledge and agree to the authorization';
    if (!answers.termsAndConditionsAccept) {
      newErrors.termsAndConditionsAccept = 'You must read and accept the Terms and Conditions';
    }

    if (!answers.typedSignature.trim()) {
      newErrors.typedSignature = 'Please type your full legal name';
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      const firstErrorKey = Object.keys(newErrors)[0];
      setTimeout(() => {
        const errorElement = document.querySelector(`[name="${firstErrorKey}"]`) as HTMLElement;
        if (errorElement) {
          errorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          errorElement.focus();
        }
      }, 100);
    }

    return Object.keys(newErrors).length === 0;
  };

  const handleNextFromQuestionnaire = () => {
    if (!validateStep2()) {
      return;
    }
    saveStep(3);
    setErrors({});
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 0);
  };

  const handleBack = () => {
    if (response && (response.success === false || response.data?.SUCCESS === "false" || response.data?.TRANSACTION?.SUCCESS === "false")) {
      clearStorage();
    }
    if (currentStep === 3) {
      saveStep(2);
    } else if (currentStep === 2) {
      saveStep(1);
    }
    setErrors({});
    setResponse(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAddSpouse = () => {
    const newDependent: Dependent = {
      firstName: '',
      lastName: '',
      dob: '',
      smoker: '',
      relationship: 'Spouse',
      address: '',
      city: '',
      state: '',
      zipcode: '',
      phone: '',
      ssn: '',
      gender: '',
      email: '',
    };

    // Reset Premium HSA selection when dependents change
    const updatedProducts = formData.products.map(product =>
      product.id === 'secure-hsa'
        ? { ...product, selectedPlan: '', extractedBenefitId: undefined, extractedPrice: undefined }
        : product
    );

    saveFormData({
      ...formData,
      dependents: [...formData.dependents, newDependent],
      products: updatedProducts
    });
  };

  const handleAddChild = () => {
    const newDependent: Dependent = {
      firstName: '',
      lastName: '',
      dob: '',
      smoker: '',
      relationship: 'Child',
      address: '',
      city: '',
      state: '',
      zipcode: '',
      phone: '',
      ssn: '',
      gender: '',
      email: '',
    };

    // Reset Premium HSA selection when dependents change
    const updatedProducts = formData.products.map(product =>
      product.id === 'secure-hsa'
        ? { ...product, selectedPlan: '', extractedBenefitId: undefined, extractedPrice: undefined }
        : product
    );

    saveFormData({
      ...formData,
      dependents: [...formData.dependents, newDependent],
      products: updatedProducts
    });
  };

  const handleChangeDependent = (index: number, field: keyof Dependent, value: string) => {
    const updatedDependents = [...formData.dependents];
    updatedDependents[index] = { ...updatedDependents[index], [field]: value };

    let updatedData = { ...formData, dependents: updatedDependents };

    if (field === 'dob') {
      const updatedProducts = formData.products.map(product =>
        product.id === 'secure-hsa'
          ? { ...product, selectedPlan: '', extractedBenefitId: undefined, extractedPrice: undefined }
          : product
      );
      updatedData = { ...updatedData, products: updatedProducts };
    }

    saveFormData(updatedData);

    const errorKey = `dependent_${index}_${field}`;
    if (errors[errorKey]) {
      setErrors(prev => ({ ...prev, [errorKey]: '' }));
    }
    if (field === 'dob' && errors.essentialPlan) {
      setErrors(prev => ({ ...prev, essentialPlan: '' }));
    }
  };

  const handleUpdateDependent = (index: number, dependent: Dependent) => {
    const updatedDependents = [...formData.dependents];
    updatedDependents[index] = dependent;
    saveFormData({ ...formData, dependents: updatedDependents });
  };

  const handleRemoveDependent = (index: number) => {
    const updatedDependents = formData.dependents.filter((_, i) => i !== index);

    // Reset Premium HSA selection when dependents change
    const updatedProducts = formData.products.map(product =>
      product.id === 'secure-hsa'
        ? { ...product, selectedPlan: '', extractedBenefitId: undefined, extractedPrice: undefined }
        : product
    );

    saveFormData({
      ...formData,
      dependents: updatedDependents,
      products: updatedProducts
    });

    const newErrors = { ...errors };
    Object.keys(newErrors).forEach(key => {
      if (key.startsWith(`dependent_${index}_`)) {
        delete newErrors[key];
      }
    });
    setErrors(newErrors);
  };

  const handleChangePlan = (productId: string, plan: string, extractedBenefitId?: string, extractedPrice?: number) => {
    const updatedProducts = formData.products.map(product =>
      product.id === productId ? { ...product, selectedPlan: plan, extractedBenefitId, extractedPrice } : product
    );
    saveFormData({ ...formData, products: updatedProducts });
  };

  const handleRemoveProduct = (productId: string) => {
    const updatedProducts = formData.products.filter(product => product.id !== productId);
    saveFormData({ ...formData, products: updatedProducts });
  };

  const handlePaymentChange = (field: keyof PaymentInfo, value: string) => {
    let updatedPayment = { ...formData.payment, [field]: value };

    if (field === 'paymentMethod') {
      updatedPayment.paymentType = value === 'ach' ? 'ACH' : value === 'list-bill' ? 'LB' : 'CC';
    }

    saveFormData({ ...formData, payment: updatedPayment });

    const errorKey = field;
    if (errors[errorKey]) {
      setErrors(prev => ({ ...prev, [errorKey]: '' }));
    }
  };

  const handleQuestionnaireChange = (field: keyof QuestionnaireAnswers, value: string | boolean) => {
    const updatedAnswers = { ...formData.questionnaireAnswers, [field]: value };
    saveFormData({ ...formData, questionnaireAnswers: updatedAnswers });

    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const handlePromoCodeChange = (code: string) => {
    patchFormData({ promoCode: code });
  };

  const handleAppliedPromoChange = (promo: AppliedPromo | null) => {
    patchFormData({ appliedPromo: promo });
  };

  const handleRemovePromo = () => {
    patchFormData({ promoCode: '', appliedPromo: null });
  };


  const handleSubmit = async () => {
    if (!validateStep3()) {
      return;
    }

    setLoading(true);
    setResponse(null);
    sessionStorage.setItem('form_submitting', 'true');

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const agentParam = formData.agent || agentId || '768413';
      const apiUrl = `${supabaseUrl}/functions/v1/enrollment-api-premiumhsa?id=${agentParam}`;
      const submissionId = getOrCreateSubmissionId();

      // Runs the PDF + gateway phase once a member exists (shared by the normal
      // success path and the 409 / idempotent-replay recovery path).
      const finishEnrollment = async (resolvedMemberId: string | null) => {
        setMemberId(resolvedMemberId);
        setFinishingEnrollment(true);
        try {
          await generateAndUploadPDF(resolvedMemberId, submissionId);
        } catch {
          // Intentionally swallow: never block the success UI on a storage/gateway
          // failure. The background cron completes any stuck gateway attach.
        }
        clearSubmissionId();
        setShowThankYou(true);
        clearStorage();
        setFinishingEnrollment(false);
        setLoading(false);
        sendAdvisorNotification(agentParam).catch(() => {});
      };

      const secureHsaProduct = formData.products.find(p => p.id === 'secure-hsa');
      const benefitIdToSend = secureHsaProduct?.extractedBenefitId || formData.benefitId;
      const priceToSend = secureHsaProduct?.extractedPrice || 0;

      const requestBody = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        dob: formData.dob,
        email: formData.email,
        smoker: formData.smoker,
        address1: formData.address1,
        city: formData.city,
        state: formData.state,
        zipcode: formData.zipcode,
        phone: formData.phone,
        ssn: formData.ssn,
        gender: formData.gender,
        agent: formData.agent,
        uniqueId: formData.uniqueId,
        effectiveDate: formData.effectiveDate,
        benefitId: benefitIdToSend,
        selectedPrice: priceToSend,
        dependents: formData.dependents.map(dep => ({
          firstName: dep.firstName,
          lastName: dep.lastName,
          dob: dep.dob,
          smoker: dep.smoker,
          relationship: dep.relationship,
          address: dep.address,
          city: dep.city,
          state: dep.state,
          zipcode: dep.zipcode,
          phone: dep.phone,
          ssn: dep.ssn,
          gender: dep.gender,
          email: dep.email,
        })),
        payment: formData.payment,
        pdid: formData.pdid,
        promoCode: formData.appliedPromo
          ? String(formData.appliedPromo.code || formData.promoCode || '').trim()
          : String(formData.promoCode || '').trim(),
        appliedPromo: formData.appliedPromo,
        referral: (formData.questionnaireAnswers.referral ?? '').trim(),
      };

      let encryptedPayload: Record<string, unknown> = requestBody;
      try {
        encryptedPayload = await encryptSensitiveFields(requestBody as Record<string, unknown>);
      } catch {
        encryptedPayload = requestBody;
      }

      const zohoResult = await syncToZoho(agentParam, encryptedPayload);

      const enrollmentPayload = {
        ...encryptedPayload,
        zohoContactId: zohoResult.zohoContactId || null,
      };
      const bodyString = JSON.stringify(enrollmentPayload);

      const maxRetries = 3;
      let attempt = 0;

      while (attempt < maxRetries) {
        try {
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Cache-Control': 'no-cache, no-store',
              'X-Submission-Id': submissionId,
            },
            cache: 'no-store',
            body: bodyString,
          });

          // Parallel/duplicate submit guard: the member API was (or is being)
          // called for this submission. Recover the member id and resume the
          // PDF/gateway phase instead of re-POSTing (which would 409 again).
          if (res.status === 409) {
            const statusResult = await fetchSubmissionStatus(submissionId, agentParam);
            if (statusResult.success && statusResult.memberId) {
              await finishEnrollment(statusResult.memberId);
              return;
            }
            if (attempt < maxRetries - 1) {
              attempt++;
              const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            setResponse({
              success: false,
              status: 409,
              error: 'Enrollment already in progress',
              message: 'Your enrollment is being processed. Please wait a moment before trying again.',
            });
            setLoading(false);
            return;
          }

          const contentType = res.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`Invalid response from server: ${text.substring(0, 100)}`);
          }

          const data = await res.json();

          if (res.ok || res.status === 400) {
            const transactionFailed =
              data.data?.TRANSACTION?.SUCCESS === false ||
              data.data?.TRANSACTION?.SUCCESS === "false";
            const transactionSuccess =
              !transactionFailed &&
              (data.data?.TRANSACTION?.SUCCESS === true ||
                data.data?.TRANSACTION?.SUCCESS === "true");
            const hasSuccessFlag =
              !transactionFailed &&
              data.success === true &&
              data.data?.SUCCESS === "true";

            // An idempotent replay (member already created for this submission)
            // is also a success — its data carries MEMBER.ID / TRANSACTION.SUCCESS.
            const enrollmentSuccess =
              (transactionSuccess || hasSuccessFlag || data.idempotentReplay === true) &&
              !transactionFailed;

            if (!enrollmentSuccess) {
              setResponse(data);
              clearFormDataOnly();
              setLoading(false);
              return;
            }

            const extractedMemberId = data.data?.MEMBER?.ID?.toString() || null;
            await finishEnrollment(extractedMemberId);
            return;
          }

          if (res.status >= 500 && attempt < maxRetries - 1) {
            attempt++;
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          setResponse(data);
          clearFormDataOnly();
          setLoading(false);
          return;

        } catch (error) {
          if (attempt < maxRetries - 1) {
            attempt++;
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          setResponse({
            success: false,
            status: 500,
            error: 'Network error',
            message: error instanceof Error ? error.message : 'Failed to connect to enrollment API',
          });
          clearFormDataOnly();
          setLoading(false);
          return;
        }
      }
    } finally {
      sessionStorage.removeItem('form_submitting');
    }
  };

  const sendAdvisorNotification = async (salesId: string) => {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const notificationUrl = `${supabaseUrl}/functions/v1/send-advisor-notification`;

      const response = await fetch(notificationUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Cache-Control': 'no-cache, no-store',
        },
        cache: 'no-store',
        body: JSON.stringify({
          salesId,
          customerFirstName: formData.firstName,
          customerLastName: formData.lastName,
          customerEmail: formData.email,
          planName: 'Premium HSA',
        }),
      });

      const result = await response.json();
      if (result.success) {
        // Notification sent successfully
      }
    } catch (error) {
      // Error sending notification handled silently
    }
  };

  interface ZohoSyncResult {
    success: boolean;
    zohoContactId?: string;
    action?: string;
    error?: string;
  }

  const syncToZoho = async (agentParam: string, encryptedPayload: Record<string, unknown>): Promise<ZohoSyncResult> => {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const zohoUrl = `${supabaseUrl}/functions/v1/zoho-sync-contact_premiumhsa`;

      const secureHsaProduct = formData.products.find(p => p.id === 'secure-hsa');
      const benefitIdToSend = secureHsaProduct?.extractedBenefitId || formData.benefitId;
      const priceToSend = secureHsaProduct?.extractedPrice || 0;

      const zohoPayload: Record<string, unknown> = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: '[encrypted]',
        phone: '[encrypted]',
        dob: '[encrypted]',
        address1: formData.address1,
        city: formData.city,
        state: formData.state,
        zipcode: formData.zipcode,
        ssn: '[encrypted]',
        gender: formData.gender,
        effectiveDate: formData.effectiveDate,
        benefitId: benefitIdToSend,
        selectedPrice: priceToSend,
        dependents: formData.dependents.map(dep => ({
          firstName: dep.firstName,
          lastName: dep.lastName,
          dob: '[encrypted]',
          relationship: dep.relationship,
          address: dep.address,
          city: dep.city,
          state: dep.state,
          zipcode: dep.zipcode,
          phone: '[encrypted]',
          ssn: '[encrypted]',
          gender: dep.gender,
          email: '[encrypted]',
          useSameAddress: dep.useSameAddress,
        })),
        agentId: agentParam,
      };

      if (encryptedPayload._encrypted) {
        zohoPayload.encrypted = encryptedPayload._encrypted;
      }

      const res = await fetch(zohoUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Cache-Control': 'no-cache, no-store',
        },
        cache: 'no-store',
        body: JSON.stringify(zohoPayload),
      });

      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return { success: false, error: 'Invalid response from Zoho sync' };
      }

      const data = await res.json();
      return {
        success: data.success === true,
        zohoContactId: data.zohoContactId,
        action: data.action,
        error: data.error,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Zoho sync failed' };
    }
  };

  const sendPdfToGateway = async (memberId: string, pdfUrl: string, submissionId?: string) => {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const gatewayApiUrl = `${supabaseUrl}/functions/v1/gateway-member-api-premiumhsa`;


      const gatewayResponse = await fetch(gatewayApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Cache-Control': 'no-cache, no-store',
        },
        cache: 'no-store',
        body: JSON.stringify({
          memberId,
          pdfUrl,
          customerEmail: formData.email,
          ...(submissionId ? { submissionId } : {}),
        }),
      });

      const contentType = gatewayResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await gatewayResponse.text();
        throw new Error('Gateway API returned invalid response');
      }

      const gatewayResult = await gatewayResponse.json();

      if (!gatewayResult.success) {
        throw new Error(gatewayResult.message || gatewayResult.error || 'Gateway API call failed');
      }

    } catch (error) {
      throw error;
    }
  };

  const generateAndUploadPDF = async (enrollmentMemberId: string | null, submissionId?: string) => {
    try {
      const pdfBlob = await generateEnrollmentPDF(formData);

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const pdfApiUrl = `${supabaseUrl}/functions/v1/save-enrollment-pdf`;


      const formDataUpload = new FormData();
      formDataUpload.append('pdf', pdfBlob, 'enrollment.pdf');
      formDataUpload.append('email', formData.email);
      if (submissionId) {
        formDataUpload.append('submissionId', submissionId);
      }
      formDataUpload.append('metadata', JSON.stringify({
        firstName: formData.firstName,
        lastName: formData.lastName,
        benefitId: formData.benefitId,
        enrollmentDate: new Date().toISOString(),
        enrollmentMemberId,
      }));

      const pdfResponse = await fetch(pdfApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Cache-Control': 'no-cache, no-store',
        },
        cache: 'no-store',
        body: formDataUpload,
      });


      const contentType = pdfResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await pdfResponse.text();
        throw new Error('PDF upload returned invalid response');
      }

      const pdfResult = await pdfResponse.json();

      if (pdfResult.success && pdfResult.pdfUrl) {
        setPdfUrl(pdfResult.pdfUrl);

        if (enrollmentMemberId) {
          await sendPdfToGateway(enrollmentMemberId, pdfResult.pdfUrl, submissionId);
        }
      } else {
        throw new Error(pdfResult.error || 'PDF upload failed');
      }
    } catch (error) {
      throw error;
    }
  };

  if (showThankYou) {
    return <ThankYouPage enrollmentData={{ firstName: formData.firstName, email: formData.email }} pdfUrl={pdfUrl} />;
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-2 py-4 xs:p-6">
      <div className="bg-white rounded-lg shadow-lg px-3 py-6 xs:p-8">
        <div className="mb-8 text-center">
          <img src="/assets/MPB-Health-No-background.png" alt="MPB Health Logo" className="h-16 xs:h-20 w-auto mx-auto mb-4" />
          <h1 className="text-xl xs:text-2xl md:text-3xl font-bold text-gray-900">Premium HSA Enrollment</h1>
        </div>

        <ProgressIndicator currentStep={currentStep} totalSteps={3} />

        <form onSubmit={(e) => e.preventDefault()} autoComplete="off">
          {currentStep === 1 && (
            <Step1PersonalInfo
              formData={formData}
              errors={errors}
              onChange={handleChange}
              onNext={handleNext}
              onAddSpouse={handleAddSpouse}
              onAddChild={handleAddChild}
              onChangeDependent={handleChangeDependent}
              onRemoveDependent={handleRemoveDependent}
              onChangePlan={handleChangePlan}
              onRemoveProduct={handleRemoveProduct}
              onBenefitIdChange={onBenefitIdChange}
              onPromoCodeChange={handlePromoCodeChange}
              onAppliedPromoChange={handleAppliedPromoChange}
              onRemovePromo={handleRemovePromo}
            />
          )}

          {currentStep === 2 && (
            <Step2Questionnaire
              formData={formData}
              errors={errors}
              onNext={handleNextFromQuestionnaire}
              onBack={handleBack}
              onQuestionnaireChange={handleQuestionnaireChange}
            />
          )}

          {currentStep === 3 && (
            <Step2AddressInfo
              formData={formData}
              errors={errors}
              onChange={handleChange}
              onBack={handleBack}
              onSubmit={handleSubmit}
              loading={loading}
              response={response}
              onUpdateDependent={handleUpdateDependent}
              onPaymentChange={handlePaymentChange}
              onClearError={handleClearError}
              invalidDependentIndices={invalidDependentIndices}
              employeeGroup={employeeGroup}
              finishingEnrollment={finishingEnrollment}
            />
          )}
        </form>
      </div>
    </div>
  );
}
