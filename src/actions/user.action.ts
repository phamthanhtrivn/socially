"use server";

import { prisma } from "@/lib/prisma";
import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

// This function is used to sync the user data from Clerk to the database
export async function syncUser() {
  try {
    const { userId: clerkId } = await auth();
    const user = await currentUser();
    if (!clerkId || !user) return;

    // check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { clerkId },
    });

    if (existingUser) {
      return existingUser;
    }

    const dbUser = await prisma.user.create({
      data: {
        clerkId,
        name: `${user.firstName || ""} ${user.lastName || ""}`,
        username:
          user.username ?? user.emailAddresses[0]?.emailAddress.split("@")[0],
        email: user.emailAddresses[0]?.emailAddress,
        image: user.imageUrl,
      },
    });

    return dbUser;
  } catch (error) {
    console.log("Error in syncUser: ", error);
  }
}

export async function getUserByClerkId(clerkId: string) {
  return prisma.user.findUnique({
    where: {
      clerkId,
    },
    include: {
      _count: {
        select: {
          followers: true,
          following: true,
          posts: true,
        },
      },
    },
  });
}

export async function getDbUserId() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const user = await getUserByClerkId(clerkId);

  if (!user) throw new Error("User not found");

  return user.id;
}

export async function getRandomUsers() {
  try {
    const userId = await getDbUserId();

    if (!userId) return [];

    // get 3 random users exclude ourselves & users that we already follow
    const randomUsers = await prisma.user.findMany({
      where: {
        AND: [
          { NOT: { id: userId } },
          { NOT: { followers: { some: { followerId: userId } } } },
        ],
      },
      select: {
        id: true,
        name: true,
        username: true,
        image: true,
        _count: {
          select: {
            followers: true,
          },
        },
      },
      take: 5,
    });

    return randomUsers;
  } catch (error) {
    console.log("Error fetching random users: ", error);
    return [];
  }
}

export async function toggleFollow(targetUserId: string) {
  try {
    const userId = await getDbUserId();

    if (!userId) return;

    if (targetUserId === userId) throw new Error("You cannot follow yourself");

    const existingFollow = await prisma.follows.findUnique({
      where: {
        followerId_followingId: {
          followerId: userId,
          followingId: targetUserId,
        },
      },
    });

    if (existingFollow) {
      // unfollow the user
      await prisma.follows.delete({
        where: {
          followerId_followingId: {
            followerId: userId,
            followingId: targetUserId,
          },
        },
      });
    } else {
      await prisma.$transaction([
        prisma.follows.create({
          data: {
            followerId: userId,
            followingId: targetUserId,
          },
        }),

        prisma.notification.create({
          data: {
            type: "FOLLOW",
            userId: targetUserId, // user being followed
            creatorId: userId, // user who followed
          },
        }),
      ]);
    }

    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.log("Error toggling follow: ", error);
    return { success: false, error: "Error toggling follow" };
  }
}
