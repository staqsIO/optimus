import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      username?: string;
      role?: string;
      boardMemberId?: string;
      displayName?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    username?: string;
    avatar?: string;
    role?: string;
    boardMemberId?: string;
    displayName?: string;
  }
}
