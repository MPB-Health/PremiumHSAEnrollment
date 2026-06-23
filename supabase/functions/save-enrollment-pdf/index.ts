import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import {
  isValidSubmissionId,
  loadSubmission,
  markSubmissionPdfStored,
} from '../_shared/enrollmentSubmissions.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Client-Info, Apikey, Cache-Control, X-Submission-Id',
};

function sanitizeEmail(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, '_at_')
    .replace(/\./g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const formData = await req.formData();
    const pdfFile = formData.get('pdf') as File;
    const customerEmail = formData.get('email') as string;
    const metadata = formData.get('metadata') as string;
    const submissionIdRaw = (formData.get('submissionId') as string | null)?.trim() ?? '';
    const submissionId = isValidSubmissionId(submissionIdRaw) ? submissionIdRaw : null;

    if (!pdfFile || !customerEmail) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Missing required fields: pdf file and email are required'
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (submissionId) {
      const existing = await loadSubmission(supabase, submissionId);
      if (
        existing &&
        existing.pdf_url &&
        ['pdf_stored', 'pdf_attached', 'completed'].includes(existing.status)
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            pdfUrl: existing.pdf_url,
            storagePath: existing.storage_path,
            filename: `${sanitizeEmail(customerEmail)}.pdf`,
            idempotentReplay: true,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    }

    const pdfBuffer = await pdfFile.arrayBuffer();
    const fileSizeInMB = pdfBuffer.byteLength / (1024 * 1024);

    if (fileSizeInMB > 10) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'PDF file size exceeds 10MB limit',
          details: `File size: ${fileSizeInMB.toFixed(2)}MB`
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const sanitizedFilename = sanitizeEmail(customerEmail);
    const filename = `${sanitizedFilename}.pdf`;
    const storagePath = `enrollments/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from('enrollment-documents')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to upload PDF to storage',
          details: uploadError.message
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const { data: urlData } = supabase.storage
      .from('enrollment-documents')
      .getPublicUrl(storagePath);

    const pdfUrl = urlData.publicUrl;

    const parsedMetadata = metadata ? JSON.parse(metadata) : {};
    await supabase
      .from('enrollment_pdfs')
      .upsert({
        customer_email: customerEmail,
        sanitized_filename: sanitizedFilename,
        pdf_url: pdfUrl,
        storage_path: storagePath,
        metadata: parsedMetadata,
      }, {
        onConflict: 'customer_email'
      });

    if (submissionId) {
      await markSubmissionPdfStored(supabase, submissionId, pdfUrl, storagePath);
    }

    return new Response(
      JSON.stringify({
        success: true,
        pdfUrl,
        storagePath,
        filename,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
