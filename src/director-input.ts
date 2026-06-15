export type DirectorInputAttachmentType = 'image' | 'file' | 'audio';
export type DirectorImageDetail = 'auto' | 'low' | 'high' | 'original';

export interface DirectorInputAttachment {
  type: DirectorInputAttachmentType;
  path: string;
  name?: string;
  mime?: string;
  detail?: DirectorImageDetail;
}

export interface DirectorInput {
  text: string;
  attachments?: DirectorInputAttachment[];
}

export type DirectorSendInput = string | DirectorInput;

export function normalizeDirectorInput(input: DirectorSendInput): DirectorInput {
  if (typeof input === 'string') return { text: input };
  return {
    text: input.text,
    attachments: input.attachments?.filter((attachment) => Boolean(attachment.path)),
  };
}

